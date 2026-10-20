// Redacts credentials before anything is written to request logs, debug dumps, error
// messages or the console. CommonJS so both the ESM engine and the CJS MITM child
// process (src/mitm) can load it.
//
// Values are replaced with a full "[REDACTED]" (an auth scheme such as "Bearer" is kept):
// even a short tail of a key narrows a brute-force search and lets logs be correlated
// across installs, and a log reader never needs it to debug routing.
//
// Two layers: pattern masking (header/field/param names, well-known key prefixes) for
// anything, and value masking (`redactValues`) for the credentials a request is known
// to carry, which also catches upstreams that echo the key back in an error body.

const REDACTED = "[REDACTED]";

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "cookie2",
]);

// Any other header naming a token/secret/key/credential, or a session *token/key/secret*.
// Plain session ids (x-session-id, x-session-affinity) are routing hints and stay visible.
const SECRET_HEADER_RE = /token|secret|credential|password|session[-_]?(token|key|secret)|(^|[-_])(api[-_]?)?key($|[-_])|auth/i;
// Non-secret headers the pattern would otherwise hide (rate-limit counters, token budgets).
const SAFE_HEADER_RE = /ratelimit|rate-limit|max-tokens|tokens?-(limit|remaining|reset|used)|^keep-alive$/i;

// Field / param names (compared lower-cased with "-" and "_" removed) that carry credentials.
const SECRET_NAMES = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "authtoken",
  "bearertoken",
  "passtoken",
  "servicetoken",
  "token",
  "apikey",
  "xapikey",
  "xgoogapikey",
  "key",
  "clientsecret",
  "secret",
  "password",
  "authorization",
  "proxyauthorization",
  "auth",
  "cookie",
  "setcookie",
  "privatekey",
]);

function normName(name) {
  let n = String(name);
  try {
    n = decodeURIComponent(n);
  } catch {
    /* keep raw */
  }
  return n.toLowerCase().replace(/[-_]/g, "");
}

function isSecretName(name) {
  return SECRET_NAMES.has(normName(name));
}

// Credentials embedded in free text.
const QUERY_RE = /((?:^|[?&#;\s])([A-Za-z0-9_%.-]+)=)([^&\s"'#<>\\]+)/g;
// JSON "name": "value" (value may contain escaped quotes) or a bare number.
const JSON_FIELD_RE = /("([A-Za-z0-9_-]+)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/g;
// The same inside a JSON-encoded string: \"name\":\"value\".
const ESC_JSON_FIELD_RE = /(\\"([A-Za-z0-9_-]+)\\"\s*:\s*)(\\"(?:[^"\\]|\\[^"])*\\")/g;
// Raw "Header: value" lines.
const HEADER_LINE_RE = /^([ \t]*)((?:proxy-)?authorization|x-api-key|x-goog-api-key|api-key|cookie|set-cookie)([ \t]*:[ \t]*)(.+)$/gim;
// Basic needs a base64-shaped token (>= 12 chars) so prose like "Basic information" stays.
const BEARER_RE = /\b(?:(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}|(Basic)\s+[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/=]))/gi;
// Well-known key formats, with a minimum length so ordinary words never match.
const KEY_PREFIX_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-|or-v1-|or-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]{20,}|AKIA[0-9A-Z]{16})/g;

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
  return str
    .replace(HEADER_LINE_RE, (_m, ws, name, sep, value) => `${ws}${name}${sep}${maskHeaderValue(value.trim())}`)
    .replace(QUERY_RE, (m, prefix, name) => (isSecretName(name) ? `${prefix}${REDACTED}` : m))
    .replace(JSON_FIELD_RE, (m, prefix, name, value) => (isSecretName(name) && !value.includes(REDACTED) ? `${prefix}"${REDACTED}"` : m))
    .replace(ESC_JSON_FIELD_RE, (m, prefix, name, value) => (isSecretName(name) && !value.includes(REDACTED) ? `${prefix}\\"${REDACTED}\\"` : m))
    .replace(BEARER_RE, (_m, bearer, basic) => `${bearer || basic} ${REDACTED}`)
    .replace(KEY_PREFIX_RE, REDACTED);
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

// Keys directly under these are field *names* in a schema (a tool's `password`
// property), not credentials, so they are never redacted themselves.
const SCHEMA_PARENTS = new Set(["properties", "input_schema", "inputschema", "parameters", "schema"]);

function maskBody(value, depth = 0, parentKey = "") {
  if (depth > 50) return value;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskBody(v, depth + 1));
  if (value && typeof value === "object") {
    const inSchema = SCHEMA_PARENTS.has(String(parentKey).toLowerCase());
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Only scalar values are replaced; objects (e.g. `auth: {type: "oauth"}`) are walked.
      const scalar = typeof v === "string" || typeof v === "number" || typeof v === "bigint";
      // `{client_secret: {value: S}}`: the wrapped value of a secret-named field is secret too.
      const wrapped = k === "value" && isSecretName(parentKey);
      if (!inSchema && scalar && v !== "" && (isSecretName(k) || wrapped)) {
        out[k] = typeof v === "string" && v.includes(REDACTED) ? v : REDACTED;
      } else out[k] = maskBody(v, depth + 1, k);
    }
    return out;
  }
  return value;
}

// Collect the credential strings a request is known to carry.
const SECRET_VALUE_FIELDS = [
  "apiKey", "accessToken", "refreshToken", "idToken", "sessionToken", "token",
  "copilotToken", "clientSecret", "mimoPassToken", "cookie", "secretAccessKey",
];

function knownSecrets(...sources) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.length >= 8) out.add(v);
  };
  for (const s of sources) {
    if (!s) continue;
    if (typeof s === "string") add(s);
    else {
      // Credentials are stored encrypted (src/lib/credentials/fields.js) and decrypted in
      // memory: redact them by value too, including those in providerSpecificData.
      for (const f of SECRET_VALUE_FIELDS) add(s[f]);
      const psd = s.providerSpecificData;
      if (psd && typeof psd === "object") for (const f of SECRET_VALUE_FIELDS) add(psd[f]);
    }
  }
  return [...out];
}

// Replace known credential values literally (also their JSON-escaped and URL-encoded forms).
function redactValues(str, secrets) {
  if (typeof str !== "string" || !str || !secrets?.length) return str;
  let out = str;
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 8) continue;
    for (const form of new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)])) {
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

// Deep version of redactValues for objects about to be logged or stored.
function redactValuesDeep(value, secrets, depth = 0) {
  if (!secrets?.length || depth > 50) return value;
  if (typeof value === "string") return redactValues(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValuesDeep(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValuesDeep(v, secrets, depth + 1);
    return out;
  }
  return value;
}

module.exports = { REDACTED, isSecretHeader, maskHeaders, maskString, maskBody, knownSecrets, redactValues, redactValuesDeep };
