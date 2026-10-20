// One name-based rule for keeping secrets out of dashboard API responses.
//
// redactSecrets() walks any JSON value: a secret-named key with a value is dropped and
// replaced by `has<Key>: true`; a URL with userinfo gets `***` in place of the password
// (or of the whole userinfo when there is no plain user to keep). restoreRedacted()
// undoes that on the way back in, so a client that saves a form built from a redacted
// response never overwrites a stored secret with a blank, a `has<Key>` flag or a mask.

export const MASK = "***";

const SECRET_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "cookies",
  "apikey",
  "apikeys",
  "privatekey",
  "secretaccesskey",
  "credentials",
  "bearer",
  "jwt",
];
// Bare `key`/`sessionKey` are exact matches only: a suffix rule would also hide
// harmless fields such as modelKey or i18nKey.
const SECRET_EXACT = new Set([
  "authorization",
  "proxyauthorization",
  "xapikey",
  "xauthtoken",
  "key",
  "sessionkey",
  // Secrets whose name doesn't say so (also encrypted at rest, src/lib/credentials/fields.js).
  "notifyresendkey",
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretKey(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  if (SECRET_EXACT.has(k)) return true;
  return SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

function hasFlagName(key) {
  const s = String(key);
  return `has${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

// The secret key a `has<Key>` flag stands for, or null.
function flagTarget(key) {
  const m = /^has([A-Z].*)$/.exec(String(key));
  if (!m) return null;
  const target = m[1].charAt(0).toLowerCase() + m[1].slice(1);
  return isSecretKey(target) ? target : null;
}

// Splits "  scheme://userinfo@host/rest". The authority ends at the first / ? or #,
// and per the URL spec the userinfo runs up to the LAST "@" inside it, so a password
// holding "@" cannot push part of itself into the host.
const URL_HEAD = /^(\s*[a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i;

function splitUrl(value) {
  if (typeof value !== "string") return null;
  const m = URL_HEAD.exec(value);
  if (!m) return null;
  const [, head, authority, rest] = m;
  const at = authority.lastIndexOf("@");
  if (at === -1) return null;
  return { head, userinfo: authority.slice(0, at), host: authority.slice(at + 1), rest };
}

// The user part worth keeping visible: plain text before the first ":" with no "@".
// Token-only userinfo (http://ghp_x@host) and odd forms (dave@pw:x) keep nothing.
function visibleUser(userinfo) {
  const colon = userinfo.indexOf(":");
  if (colon === -1) return null;
  const user = userinfo.slice(0, colon);
  return user && !user.includes("@") ? user : null;
}

function maskUserinfo(userinfo) {
  const user = visibleUser(userinfo);
  return user ? `${user}:${MASK}` : MASK;
}

// "http://user:pass@host" -> "http://user:***@host"; "http://tok@host" -> "http://***@host".
export function maskUrlCredentials(value) {
  const parts = splitUrl(value);
  if (!parts || !parts.userinfo) return value;
  return `${parts.head}${maskUserinfo(parts.userinfo)}@${parts.host}${parts.rest}`;
}

export function isMaskedUrl(value) {
  const parts = splitUrl(value);
  return !!parts && (parts.userinfo === MASK || parts.userinfo.endsWith(`:${MASK}`));
}

export class MaskedUrlError extends Error {
  constructor() {
    super(
      "The proxy URL still contains the hidden password (***). Re-enter the full URL with its password, or keep the same user so the saved password can be reused."
    );
    this.name = "MaskedUrlError";
    this.status = 400;
  }
}

// A URL echoed back from a redacted response -> the URL to store. The saved userinfo is
// put back when the masked userinfo still names the same user (host and path may have
// changed). A mask that can't be resolved throws MaskedUrlError instead of storing "***".
export function restoreMaskedUrl(incoming, stored) {
  if (!isMaskedUrl(incoming)) return incoming;
  const inc = splitUrl(incoming);
  const prev = splitUrl(stored);
  if (prev && prev.userinfo && maskUserinfo(prev.userinfo) === inc.userinfo) {
    return `${inc.head}${prev.userinfo}@${inc.host}${inc.rest}`;
  }
  throw new MaskedUrlError();
}

function isRedactable(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  return typeof value === "object";
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "string") return maskUrlCredentials(value);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (isSecretKey(key) && isRedactable(v)) {
      out[hasFlagName(key)] = true;
      continue;
    }
    out[key] = redactSecrets(v);
  }
  return out;
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function restoreValue(v, prev) {
  if (typeof v === "string") {
    return isMaskedUrl(v) ? restoreMaskedUrl(v, typeof prev === "string" ? prev : undefined) : v;
  }
  if (Array.isArray(v)) {
    const prevArr = Array.isArray(prev) ? prev : [];
    return v.map((item, i) => restoreValue(item, prevArr[i]));
  }
  if (isPlainObject(v)) {
    const restored = restoreRedacted(v, prev);
    // Dropped echoes (flags, blanks) mean "keep what is stored" at this level too.
    const droppedSome = Object.keys(restored).length !== Object.keys(v).length;
    return droppedSome && isPlainObject(prev) ? { ...prev, ...restored } : restored;
  }
  return v;
}

// Merge-safe input: drop what the client could only have echoed back from a redacted
// response. Blank secret = unchanged; null still means "clear it". Throws
// MaskedUrlError for a masked URL that can't be matched to the stored one.
export function restoreRedacted(incoming, existing) {
  if (!isPlainObject(incoming)) return incoming;
  const prev = isPlainObject(existing) ? existing : {};
  const out = {};
  for (const [key, v] of Object.entries(incoming)) {
    if (typeof v === "boolean" && flagTarget(key)) continue;
    if (isSecretKey(key) && v === "") continue;
    out[key] = restoreValue(v, prev[key]);
  }
  return out;
}
