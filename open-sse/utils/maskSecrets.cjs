// Redacts credentials before anything is written to request logs, debug dumps or the console.
// CommonJS so both the ESM engine and the CJS MITM child process (src/mitm) can load it.
//
// Values are replaced with a full "[REDACTED]" (an auth scheme such as "Bearer" is kept):
// even a short tail of a key narrows a brute-force search and lets logs be correlated
// across installs, and a log reader never needs it to debug routing.

const REDACTED = "[REDACTED]";

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

// Any other header naming a token/secret/key/session/credential.
const SECRET_HEADER_RE = /token|secret|session|credential|password|(^|[-_])(api[-_]?)?key($|[-_])|auth/i;
// Non-secret headers the pattern would otherwise hide (rate-limit counters, token budgets).
const SAFE_HEADER_RE = /ratelimit|rate-limit|max-tokens|tokens?-(limit|remaining|reset|used)|^keep-alive$/i;

// JSON body fields that carry credentials (OAuth refresh/exchange bodies, key configs).
const SECRET_FIELD_RE = /^(access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|api[-_]?key|apikey|x-api-key|x-goog-api-key|client[-_]?secret|password|authorization|cookie|private[-_]?key)$/i;

// Credentials embedded in free text: URL query params and bearer tokens.
const QUERY_RE = /([?&](?:key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|auth|password)=)[^&\s"'#<>\\]+/gi;
const JSON_FIELD_RE = /("(?:access_token|refresh_token|id_token|session_token|api_?key|client_secret|password)"\s*:\s*")[^"]*/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

function isSecretHeader(name) {
  const lower = String(name).toLowerCase();
  if (SECRET_HEADERS.has(lower)) return true;
  if (SAFE_HEADER_RE.test(lower)) return false;
  return SECRET_HEADER_RE.test(lower);
}

function maskHeaderValue(value) {
  if (Array.isArray(value)) return value.map(maskHeaderValue);
  if (value == null || value === "") return value;
  const m = /^(Bearer|Basic|Token|Digest)\s+\S/i.exec(String(value));
  return m ? `${m[1]} ${REDACTED}` : REDACTED;
}

function maskString(str) {
  if (typeof str !== "string" || !str) return str;
  return str.replace(QUERY_RE, `$1${REDACTED}`).replace(JSON_FIELD_RE, `$1${REDACTED}`).replace(BEARER_RE, `$1 ${REDACTED}`);
}

// Accepts a plain object, a Headers/Map-like object, or an entries array.
function maskHeaders(headers) {
  if (!headers) return {};
  let entries;
  if (typeof headers.entries === "function" && !Array.isArray(headers)) entries = [...headers.entries()];
  else if (Array.isArray(headers)) entries = headers;
  else entries = Object.entries(headers);
  const out = {};
  for (const [k, v] of entries) out[k] = isSecretHeader(k) ? maskHeaderValue(v) : typeof v === "string" ? maskString(v) : v;
  return out;
}

function maskBody(value, depth = 0) {
  if (depth > 50) return value;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskBody(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELD_RE.test(k) && v != null && typeof v !== "object" && v !== "" && !String(v).includes(REDACTED) ? REDACTED : maskBody(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { REDACTED, isSecretHeader, maskHeaders, maskString, maskBody };
