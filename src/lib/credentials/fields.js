// Which stored fields are credentials, and sealing/opening them inside a row's JSON.
//
// A field is a credential by its name, at any depth of the row's JSON (connections
// keep provider secrets in providerSpecificData). Only non-empty strings are encrypted;
// booleans like requireApiKey and numbers like expiresAt are left alone.
import { decryptValue, encryptValue, envelopeKeyId, isEnvelope } from "./envelope.js";
import { getKeyring } from "./keyring.js";

// Names ending like a secret: apiKey, accessToken, refreshToken, idToken, sessionToken,
// copilotToken, mimoPassToken, clientSecret, oidcClientSecret, password, cookie(s), ...
const SECRET_SUFFIX = /(token|secret|password|passwd|cookies?|apikey|privatekey|secretaccesskey)$/i;
// Secrets whose name doesn't say so: AWS access key ids and URLs that can embed user:pass
// or a deploy token.
const SECRET_NAMES = new Set([
  "accessKeyId",
  "notifyResendKey",
  "proxyUrl",
  "connectionProxyUrl",
  "outboundProxyUrl",
  "updateWebhookUrl",
  "mitmSudoEncrypted",
]);

export function isSecretField(name) {
  return SECRET_NAMES.has(name) || SECRET_SUFFIX.test(name);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Visits every credential string in `obj` (recursively): fn(value, path) returns the replacement. */
function mapSecrets(obj, fn, prefix = "") {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" && v !== "" && isSecretField(k)) out[k] = fn(v, path);
    else if (isPlainObject(v)) out[k] = mapSecrets(v, fn, path);
    else out[k] = v;
  }
  return out;
}

/** Encrypts every credential field (re-encrypts envelopes under an older key). `where` = { table, column, id }. */
export function sealSecrets(obj, where, ring = getKeyring()) {
  return mapSecrets(obj, (v, path) => {
    const ctx = { ...where, path };
    if (isEnvelope(v)) {
      if (envelopeKeyId(v) === ring.currentId) return v;
      return encryptValue(decryptValue(v, ctx, ring), ctx, ring);
    }
    return encryptValue(v, ctx, ring);
  });
}

/**
 * Decrypts every credential field. A plaintext value is returned as-is: it is only possible
 * between an older version writing it and the next boot's heal (see db/helpers/credentialsSeal.js).
 */
export function openSecrets(obj, where, ring) {
  let r = ring;
  return mapSecrets(obj, (v, path) => {
    if (!isEnvelope(v)) return v;
    r ||= getKeyring();
    return decryptValue(v, { ...where, path }, r);
  });
}

/** Summary of the credential fields in `obj`: { plaintext, keyIds:Set }. */
export function inspectSecrets(obj) {
  const res = { plaintext: 0, keyIds: new Set() };
  mapSecrets(obj, (v) => {
    if (isEnvelope(v)) res.keyIds.add(envelopeKeyId(v));
    else res.plaintext++;
    return v;
  });
  return res;
}
