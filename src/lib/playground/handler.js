// POST /api/dashboard/chat/completions: the dashboard Playground's chat endpoint.
//
// Security model (the route spends provider money, so it must not become a keyless proxy):
//   - Auth: a valid dashboard session cookie. With requireLogin off, only local requests
//     (same rule as keyless /v1 access). API keys, the CLI token and any Authorization /
//     x-api-key / x-goog-api-key header never authenticate here and are not forwarded.
//   - CSRF: JSON content type only, and Origin must be this host (or, without Origin,
//     Sec-Fetch-Site: same-origin). No CORS headers, no OPTIONS handler. The session
//     cookie is SameSite=Lax, which already keeps it off cross-site POSTs; the Origin
//     check also covers same-site, cross-origin pages (another port on the same host).
//   - Engine: the request runs AS the API key the user picked (body.keyId, looked up
//     here). The internal request carries that key, so handleChat applies the same key
//     validation, access list, budgets, price plan and usage attribution as /v1. The
//     secret never leaves the server: it is not in any response, and chatCore redacts
//     the request's client key from logs and upstream errors (knownSecrets); error
//     bodies here also strip it by value.
//   - Abuse: per-session and per-IP rate and concurrency limits, a body size cap and a
//     max_tokens ceiling.
//   - Not an open proxy: whitelisted fields only, model must resolve to a configured
//     connection or combo, images only as data: URLs, error bodies redacted.
import { createHash } from "node:crypto";
import { handleChat } from "@/sse/handlers/chat.js";
import { getComboModels, getModelInfo, stripComboPrefix } from "@/sse/services/model.js";
import { initTranslators } from "open-sse/translator/index.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { getClientIp } from "@/lib/auth/loginLimiter.js";
import { isLocalRequest } from "@/dashboardGuard.js";
import { redactSecrets } from "@/lib/requestTrace.js";
import { MAX_BODY_BYTES, validatePlaygroundBody } from "./validate.js";
import { acquirePlaygroundSlot } from "./limits.js";
import { resolvePlaygroundKey } from "./keys.js";

export const PLAYGROUND_PATH = "/api/dashboard/chat/completions";
const SESSION_COOKIE = "auth_token";

let translatorsReady = null;
const ensureTranslators = () => (translatorsReady ??= Promise.resolve(initTranslators()));

function json(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function readCookie(request, name) {
  const fromNext = request.cookies?.get?.(name)?.value;
  if (fromNext) return fromNext;
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The caller's session bucket, or null when the request is not a dashboard session. */
async function authenticate(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token && (await verifyDashboardAuthToken(token))) {
    return `session:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }
  // requireLogin off: the dashboard is open, but spending provider money without a key
  // stays local-only, exactly like keyless /v1 access (dashboardGuard canAccessPublicLlmApi).
  const settings = await getSettings().catch(() => null);
  if (settings?.requireLogin === false && isLocalRequest(request)) return "session:local";
  return null;
}

/** Same-origin check: Origin must be this host; without Origin, Sec-Fetch-Site must say so. */
function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  const host = (request.headers.get("host") || "").toLowerCase();
  if (origin) {
    try {
      const url = new URL(origin);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !!host &&
        url.host.toLowerCase() === host
      );
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

const isJsonContentType = (request) =>
  /^application\/json\s*(;|$)/i.test((request.headers.get("content-type") || "").trim());

/** Reads the body up to MAX_BODY_BYTES; null when it is larger. */
async function readBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** True when the model names a combo or a provider with at least one active connection. */
async function isConfiguredModel(model) {
  const { model: bare } = stripModelContextMarker(model);
  const name = stripComboPrefix(bare);
  if (await getComboModels(name)) return true;
  if (name !== bare) return false; // "combo/<name>" must be a combo
  const info = await getModelInfo(name);
  if (!info?.provider) return false;
  const connections = await getProviderConnections({ provider: info.provider, isActive: true });
  return connections.length > 0;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Client-safe error message: credentials and upstream URLs removed. */
export function redactErrorMessage(message, secrets = [], keep = []) {
  let text = typeof message === "string" ? message : message == null ? "" : JSON.stringify(message);
  for (const secret of secrets) if (secret) text = text.split(secret).join("***");
  // Strings the caller sent and we validated (the model id) are not secrets; a provider-node
  // id inside one is long enough to look like a token, so shield them from redactSecrets.
  const shields = keep.filter((k) => typeof k === "string" && k.length > 0 && !secrets.includes(k));
  shields.forEach((k, i) => (text = text.split(k).join(`\u0000${i}\u0000`)));
  let out = redactSecrets(text.replace(URL_RE, "[url]")) || "Request failed";
  shields.forEach((k, i) => (out = out.split(`\u0000${i}\u0000`).join(k)));
  return out;
}

async function errorFrom(response, secrets, keep) {
  let message = `Request failed (${response.status})`;
  try {
    const data = JSON.parse(await response.text());
    const raw = data?.error?.message ?? data?.error ?? data?.message;
    if (raw) message = raw;
  } catch {
    /* non-JSON error body: keep the generic message */
  }
  const retryAfter = response.headers.get("retry-after");
  return json(
    response.status,
    redactErrorMessage(message, secrets, keep),
    retryAfter ? { "Retry-After": retryAfter } : {},
  );
}

/** The engine's response with only safe headers, releasing the slot when the body ends. */
function passThrough(response, release) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const type = response.headers.get("content-type");
  if (type) headers.set("Content-Type", type);
  if (type?.includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  if (!response.body) {
    release();
    return new Response(null, { status: response.status, headers });
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers });
}

/**
 * Shared gate for every Playground route: a dashboard session (local-only when
 * requireLogin is off) and, for POSTs, same-origin JSON. Returns { sessionKey } or
 * { error: Response }.
 */
export async function checkPlaygroundRequest(request, { post = true } = {}) {
  const sessionKey = await authenticate(request);
  if (!sessionKey) return { error: json(401, "Sign in to the dashboard to use the Playground") };
  if (post && !isSameOrigin(request)) return { error: json(403, "Cross-origin request refused") };
  if (post && !isJsonContentType(request))
    return { error: json(415, "Content-Type must be application/json") };
  return { sessionKey };
}

export async function handlePlaygroundChat(request) {
  const gate = await checkPlaygroundRequest(request);
  if (gate.error) return gate.error;
  const { sessionKey } = gate;

  const slot = acquirePlaygroundSlot([sessionKey, `ip:${getClientIp(request)}`]);
  if (slot.error) return json(429, slot.error, { "Retry-After": String(slot.retryAfter) });

  let handedOff = false;
  let secret = null;
  try {
    const text = await readBody(request);
    if (text === null)
      return json(413, `Request body is larger than ${MAX_BODY_BYTES / (1024 * 1024)} MB`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json(400, "Invalid JSON body");
    }
    const { body, keyId, error } = validatePlaygroundBody(parsed);
    if (error) return json(400, error);
    const key = await resolvePlaygroundKey(keyId);
    if (!key) return json(404, "API key not found: pick another key");
    if (!key.isActive) return json(403, `API key "${key.name}" is disabled`);
    secret = key.key;
    if (!(await isConfiguredModel(body.model)))
      return json(404, "Model is not available: connect its provider or create the combo first");

    // A fresh request: only the validated body, fixed headers and the picked key reach the
    // engine; no client header (cookies, a client Authorization or x-api-key, pipeline or
    // regent control headers) is read, logged or forwarded upstream.
    const internal = new Request(new URL(PLAYGROUND_PATH, request.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream ? "text/event-stream" : "application/json",
        "user-agent": "regent-playground",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
    await ensureTranslators();
    const response = await handleChat(internal);
    if (!response) return json(502, "No response");
    if (!response.ok) return await errorFrom(response, [secret], [body.model]);
    handedOff = true;
    return passThrough(response, () => slot.release());
  } catch (e) {
    return json(500, redactErrorMessage(e?.message || "Playground request failed", [secret]));
  } finally {
    if (!handedOff) slot.release();
  }
}
