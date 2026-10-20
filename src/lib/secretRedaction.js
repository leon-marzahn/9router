// One name-based rule for keeping secrets out of dashboard API responses.
//
// redactSecrets() walks any JSON value: a secret-named key with a value is dropped and
// replaced by `has<Key>: true`; a URL with userinfo keeps the user but gets `***` for
// the password. restoreRedacted() undoes that on the way back in, so a client that
// saves a form built from a redacted response never overwrites a stored secret with
// a blank, a `has<Key>` flag or a masked URL.

export const MASK = "***";

const SECRET_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "cookies",
  "apikey",
  "privatekey",
  "secretaccesskey",
];
const SECRET_EXACT = new Set(["authorization", "proxyauthorization", "xapikey", "xauthtoken"]);

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

const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s:]*):([^/?#@\s]*)@/i;

// "http://user:pass@host" -> "http://user:***@host". Other strings come back unchanged.
export function maskUrlCredentials(value) {
  if (typeof value !== "string") return value;
  return value.replace(URL_USERINFO, (all, scheme, user, pass) => (pass ? `${scheme}${user}:${MASK}@` : all));
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

// Merge-safe input: drop what the client could only have echoed back from a redacted
// response. Blank secret = unchanged; null still means "clear it".
export function restoreRedacted(incoming, existing) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const prev = existing && typeof existing === "object" ? existing : {};
  const out = {};
  for (const [key, v] of Object.entries(incoming)) {
    if (typeof v === "boolean" && flagTarget(key)) continue;
    if (isSecretKey(key) && v === "") continue;
    if (typeof v === "string" && v.includes(`:${MASK}@`)) {
      out[key] = typeof prev[key] === "string" && maskUrlCredentials(prev[key]) === v ? prev[key] : v;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && prev[key] && typeof prev[key] === "object") {
      const restored = restoreRedacted(v, prev[key]);
      // Dropped echoes (flags, blanks) mean "keep what is stored" one level down too.
      const droppedSome = Object.keys(restored).length !== Object.keys(v).length;
      out[key] = droppedSome ? { ...prev[key], ...restored } : restored;
      continue;
    }
    out[key] = v;
  }
  return out;
}

// A masked URL echoed back for a single stored value (proxy pool URL) -> the stored value.
export function restoreMaskedUrl(incoming, stored) {
  if (typeof incoming !== "string" || typeof stored !== "string") return incoming;
  return incoming.includes(`:${MASK}@`) && maskUrlCredentials(stored) === incoming ? stored : incoming;
}
