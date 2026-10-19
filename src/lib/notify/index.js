// Server-side email notifications (budgets, alerts…).
//
//   notify({ to, subject, text, html?, dedupeKey? })  → never throws; resolves to a result
//   sendEmail(settings, msg)                          → throws; used by the "Send test" route
//
// Fail-safe: callers sit on request paths, so `notify` logs and swallows every error.
// Anti-spam: a `dedupeKey` is delivered at most once per DEDUPE_TTL_MS, and all mail is
// capped at RATE_LIMIT per RATE_WINDOW_MS (in-memory, per process). Callers that need
// "once per period" across restarts persist that themselves (budgets do).
import dns from "node:dns";
import net from "node:net";
import { getSettings } from "@/lib/db/index.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { fromAddress, hasCrlf, isEmail, isReady, parseFrom } from "./config.js";

export const RESEND_API_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;
export const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
export const RATE_LIMIT = 30;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;

const state = (global._regentNotifyState ??= { sentKeys: new Map(), window: [] });

/** Test hook. */
export function resetNotifyState() {
  state.sentKeys.clear();
  state.window.length = 0;
}

function allowPrivateSmtp() {
  return process.env.NOTIFY_SMTP_ALLOW_PRIVATE === "true";
}

/** Validates the message; throws on header injection or bad addresses. */
export function validateMessage({ to, subject, text, html }) {
  const list = (Array.isArray(to) ? to : [to]).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!list.length) throw new Error("No recipient");
  if (list.length > 10) throw new Error("Too many recipients");
  for (const addr of list) if (!isEmail(addr)) throw new Error("Invalid recipient address");
  const subj = String(subject ?? "");
  if (!subj.trim() || hasCrlf(subj) || subj.length > MAX_SUBJECT)
    throw new Error("Invalid subject");
  const body = String(text ?? "");
  if (!body.trim() || body.length > MAX_BODY) throw new Error("Invalid body");
  if (html !== undefined && String(html).length > MAX_BODY) throw new Error("Invalid body");
  return {
    to: list,
    subject: subj,
    text: body,
    html: html === undefined ? undefined : String(html),
  };
}

/**
 * Resolves the SMTP host once and checks the address with the shared SSRF guard,
 * then connects to that exact IP (TLS still verifies the hostname), so DNS can't
 * swap in an internal address between the check and the connection.
 */
export async function resolveSmtpHost(host, { lookup = dns.promises.lookup } = {}) {
  const bare = String(host).replace(/^\[|\]$/g, "");
  const address = net.isIP(bare) ? bare : (await lookup(bare)).address;
  if (!allowPrivateSmtp()) {
    try {
      assertPublicUrl(`http://${net.isIPv6(address) ? `[${address}]` : address}/`);
    } catch {
      throw new Error(
        "SMTP host resolves to a private or internal address (set NOTIFY_SMTP_ALLOW_PRIVATE=true to allow a local relay)",
      );
    }
  }
  return address;
}

async function sendSmtp(s, msg, from) {
  const nodemailer = (await import("nodemailer")).default;
  const host = s.notifySmtpHost;
  const address = await resolveSmtpHost(host);
  const tls = s.notifySmtpTls || "starttls";
  const transport = nodemailer.createTransport({
    host: address,
    port: Number(s.notifySmtpPort) || 587,
    secure: tls === "tls",
    requireTLS: tls === "starttls",
    ignoreTLS: tls === "none",
    tls: { servername: net.isIP(host) ? undefined : host, minVersion: "TLSv1.2" },
    auth: s.notifySmtpUser
      ? { user: s.notifySmtpUser, pass: s.notifySmtpPassword || "" }
      : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const info = await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { id: info.messageId || null };
  } finally {
    transport.close();
  }
}

async function sendResend(s, msg, from, fetchImpl) {
  const res = await fetchImpl(RESEND_API_URL, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.notifyResendKey}` },
    body: JSON.stringify({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status < 200 || res.status >= 300) {
    // Resend's error body can echo request details; report only the status.
    throw new Error(`Resend answered ${res.status}`);
  }
  const data = await res.json().catch(() => ({}));
  return { id: typeof data?.id === "string" ? data.id : null };
}

/** Sends one email with the given settings. Throws with a short, secret-free message. */
export async function sendEmail(settings, message, { fetchImpl = fetch } = {}) {
  if (!isReady(settings)) throw new Error("Email delivery isn't set up");
  const msg = validateMessage(message);
  const from = parseFrom(settings.notifyFrom);
  if (!from || !fromAddress(from)) throw new Error("Sender address isn't valid");
  if (settings.notifyProvider === "smtp") return sendSmtp(settings, msg, from);
  if (settings.notifyProvider === "resend") return sendResend(settings, msg, from, fetchImpl);
  throw new Error("Email delivery isn't set up");
}

function takeRateSlot(now) {
  while (state.window.length && now - state.window[0] > RATE_WINDOW_MS) state.window.shift();
  if (state.window.length >= RATE_LIMIT) return false;
  state.window.push(now);
  return true;
}

/** Short error text for logs and the dashboard, with the saved secrets cut out. */
export function safeError(e, settings = {}) {
  let m = String(e?.message || e || "error");
  for (const secret of [settings.notifySmtpPassword, settings.notifyResendKey]) {
    if (secret && String(secret).length >= 4) m = m.split(String(secret)).join("***");
  }
  return m.replace(/[\r\n]+/g, " ").slice(0, 200);
}

/**
 * Fire-and-forget friendly. Never throws.
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
export async function notify(message, { settings, fetchImpl, now = Date.now() } = {}) {
  let s = settings || {};
  try {
    s = settings || (await getSettings());
    if (!isReady(s)) return { ok: false, skipped: "not-configured" };
    const key = message?.dedupeKey ? String(message.dedupeKey) : null;
    if (key) {
      const at = state.sentKeys.get(key);
      if (at && now - at < DEDUPE_TTL_MS) return { ok: false, skipped: "duplicate" };
    }
    if (!takeRateSlot(now)) {
      console.warn("[notify] rate limit reached, dropping email");
      return { ok: false, skipped: "rate-limited" };
    }
    if (key) state.sentKeys.set(key, now);
    if (state.sentKeys.size > 5000) {
      for (const [k, at] of state.sentKeys) if (now - at >= DEDUPE_TTL_MS) state.sentKeys.delete(k);
    }
    await sendEmail(s, message, { fetchImpl });
    return { ok: true };
  } catch (e) {
    const error = safeError(e, s);
    console.warn(`[notify] email not sent: ${error}`);
    return { ok: false, error };
  }
}
