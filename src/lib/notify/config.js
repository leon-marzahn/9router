// Email delivery settings (Settings → Notifications). Stored as flat keys in the
// settings row. The SMTP password and Resend key are secrets: they are only ever
// written through /api/settings/notifications, never returned, never exported.

export const NOTIFY_PROVIDERS = ["none", "smtp", "resend"];
export const SMTP_TLS_MODES = ["tls", "starttls", "none"];

/** Every key this feature owns. None of them can be mass-assigned via PATCH /api/settings. */
export const NOTIFY_KEYS = [
  "notifyProvider",
  "notifyFrom",
  "notifyAdminEmail",
  "notifySmtpHost",
  "notifySmtpPort",
  "notifySmtpTls",
  "notifySmtpUser",
  "notifySmtpPassword",
  "notifyResendKey",
  "notifyLastTest",
];
export const NOTIFY_SECRET_KEYS = ["notifySmtpPassword", "notifyResendKey"];

const CRLF = /[\r\n]/;
// Deliberately simple: one address, no display-name tricks, no CR/LF.
const EMAIL = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/;
// Hostname or IP literal; no scheme, path, port or whitespace.
const HOST = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)$/;

export function hasCrlf(v) {
  return CRLF.test(String(v ?? ""));
}

export function isEmail(v) {
  const s = String(v ?? "");
  return s.length <= 254 && !hasCrlf(s) && EMAIL.test(s);
}

/** "Name <a@b.c>" or "a@b.c". Returns the normalized string or null. */
export function parseFrom(v) {
  const s = String(v ?? "").trim();
  if (!s || hasCrlf(s) || s.length > 320) return null;
  const m = s.match(/^([^<>"\r\n]{0,64}?)\s*<([^<>]+)>$/);
  if (m) return isEmail(m[2]) ? (m[1].trim() ? `${m[1].trim()} <${m[2]}>` : m[2]) : null;
  return isEmail(s) ? s : null;
}

/** Bare address of a From value ("Name <a@b.c>" → "a@b.c"). */
export function fromAddress(from) {
  const m = String(from || "").match(/<([^<>]+)>$/);
  return m ? m[1] : String(from || "");
}

/**
 * Validates a PATCH body. Secrets: undefined = keep, "" = clear, string = set.
 * Returns { patch } or { error }.
 */
export function validateNotifyPatch(body = {}) {
  const patch = {};
  const str = (v) => String(v ?? "").trim();
  if (body.provider !== undefined) {
    if (!NOTIFY_PROVIDERS.includes(body.provider)) return { error: "Unknown email provider" };
    patch.notifyProvider = body.provider;
  }
  if (body.from !== undefined) {
    if (str(body.from) === "") patch.notifyFrom = "";
    else {
      const from = parseFrom(body.from);
      if (!from)
        return {
          error: "Sender must be an address like alerts@example.com or Name <alerts@example.com>",
        };
      patch.notifyFrom = from;
    }
  }
  if (body.adminEmail !== undefined) {
    const v = str(body.adminEmail);
    if (v && !isEmail(v)) return { error: "Admin email isn't a valid address" };
    patch.notifyAdminEmail = v;
  }
  if (body.smtpHost !== undefined) {
    const v = str(body.smtpHost);
    if (v && (!HOST.test(v) || v.length > 253))
      return { error: "SMTP host must be a hostname or IP, without port or scheme" };
    patch.notifySmtpHost = v;
  }
  if (body.smtpPort !== undefined) {
    const n = Number(body.smtpPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: "SMTP port must be 1–65535" };
    patch.notifySmtpPort = n;
  }
  if (body.smtpTls !== undefined) {
    if (!SMTP_TLS_MODES.includes(body.smtpTls)) return { error: "Unknown TLS mode" };
    patch.notifySmtpTls = body.smtpTls;
  }
  if (body.smtpUser !== undefined) {
    const v = str(body.smtpUser);
    if (hasCrlf(v) || v.length > 320) return { error: "SMTP user isn't valid" };
    patch.notifySmtpUser = v;
  }
  if (body.smtpPassword !== undefined) {
    const v = String(body.smtpPassword ?? "");
    if (hasCrlf(v) || v.length > 1024) return { error: "SMTP password isn't valid" };
    patch.notifySmtpPassword = v;
  }
  if (body.resendKey !== undefined) {
    const v = str(body.resendKey);
    if (v && !/^[A-Za-z0-9_-]{8,256}$/.test(v)) return { error: "That Resend API key isn't valid" };
    patch.notifyResendKey = v;
  }
  return { patch };
}

/** What the dashboard may see: no secrets, only whether they are set. */
export function publicNotifyState(s = {}) {
  return {
    provider: NOTIFY_PROVIDERS.includes(s.notifyProvider) ? s.notifyProvider : "none",
    from: s.notifyFrom || "",
    adminEmail: s.notifyAdminEmail || "",
    smtp: {
      host: s.notifySmtpHost || "",
      port: Number(s.notifySmtpPort) || 587,
      tls: SMTP_TLS_MODES.includes(s.notifySmtpTls) ? s.notifySmtpTls : "starttls",
      user: s.notifySmtpUser || "",
      passwordConfigured: !!s.notifySmtpPassword,
    },
    resend: { keyConfigured: !!s.notifyResendKey },
    ready: isReady(s),
    lastTest: s.notifyLastTest || null,
  };
}

export function isReady(s = {}) {
  if (!parseFrom(s.notifyFrom)) return false;
  if (s.notifyProvider === "smtp") return !!s.notifySmtpHost;
  if (s.notifyProvider === "resend") return !!s.notifyResendKey;
  return false;
}
