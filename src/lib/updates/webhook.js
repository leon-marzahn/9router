// Redeploy webhook: the user's own platform deploy hook (Coolify, Portainer,
// CapRover, Dokploy…). The URL is a secret — it usually embeds a token — so it
// never leaves the server (see SECRET_UPDATE_KEYS).
import net from "node:net";
import { compareVersions, isEligibleUpdate } from "./version.js";

export const WEBHOOK_URL_KEY = "updateWebhookUrl";
/** Server-managed keys: never mass-assigned, never returned raw, never exported. */
export const UPDATE_STATE_KEYS = [
  "updateWebhookUrl",
  "updateWebhookToken",
  "updateWebhookLastVersion",
  "updateWebhookLastResult",
];
const TIMEOUT_MS = 15_000;

function isPrivateIp(host) {
  const ip = host.replace(/^\[|\]$/g, "");
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    return (
      l === "::1" ||
      l.startsWith("fc") ||
      l.startsWith("fd") ||
      l.startsWith("fe80:") ||
      l.startsWith("::ffff:127.") ||
      l.startsWith("::ffff:10.") ||
      l.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

/** Hosts that are only reachable on a private network: plain http is tolerated for these. */
export function isLocalHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (isPrivateIp(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  return !h.includes(".") && !h.includes(":") && h.length > 0; // single-label, e.g. "coolify"
}

/**
 * Validates a deploy-hook URL. https anywhere; http only for private/loopback
 * hosts (self-hosted platforms on a LAN often have no certificate). No
 * credentials in the userinfo part — put tokens in the path/query the platform gives you.
 */
export function validateWebhookUrl(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return { ok: false, error: "That isn't a valid URL" };
  }
  if (u.username || u.password) return { ok: false, error: "Leave user:password out of the URL" };
  if (u.protocol === "https:") return { ok: true, url: u.toString(), host: u.host };
  if (u.protocol === "http:" && isLocalHost(u.hostname))
    return { ok: true, url: u.toString(), host: u.host };
  if (u.protocol === "http:")
    return { ok: false, error: "Use https (plain http only works for local network addresses)" };
  return { ok: false, error: "Only https URLs are supported" };
}

export function webhookHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The firing rules, pure so they can be tested:
 * a hook is set, `candidate` is newer than what's running and on the followed
 * channel, and newer than anything this hook was already called for (so one call per version, and never a downgrade).
 */
export function shouldFire({ url, current, candidate, channel, lastVersion }) {
  if (!url || !candidate) return false;
  if (!isEligibleUpdate(current, candidate, { channel })) return false;
  if (lastVersion && compareVersions(candidate, lastVersion) <= 0) return false;
  return true;
}

/** POSTs version info only. Redirects are not followed (a 3xx counts as a failure). */
export async function sendWebhook(
  url,
  { version, current, test = false },
  { fetchImpl = fetch, token = "" } = {},
) {
  const v = validateWebhookUrl(url);
  const at = new Date().toISOString();
  if (!v.ok) return { ok: false, at, version, test, error: v.error };
  try {
    const res = await fetchImpl(v.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `regent/${current}`,
        // Some platforms (Coolify's /api/v1/deploy) want an API token as a Bearer header.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ event: test ? "regent.test" : "regent.update", version, current }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      at,
      version,
      test,
      status: res.status,
      ...(ok
        ? {}
        : {
            error:
              res.status >= 300 && res.status < 400
                ? "Redirect not followed"
                : `Answered ${res.status}`,
          }),
    };
  } catch (e) {
    return {
      ok: false,
      at,
      version,
      test,
      error: e?.name === "TimeoutError" ? "Timed out" : "Couldn't reach it",
    };
  }
}
