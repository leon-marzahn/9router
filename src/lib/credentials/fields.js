// Which stored fields are credentials, and sealing/opening them inside a row's JSON.
//
// A field is a credential by its name, at any depth of the row's JSON (connections
// keep provider secrets in providerSpecificData). Only non-empty strings are encrypted;
// booleans like requireApiKey and numbers like expiresAt are left alone.
import { decryptValue, encryptValue, envelopeKeyId, isEnvelope } from "./envelope.js";
import { isSecretKey } from "@/lib/secretRedaction.js";
import { getKeyring } from "./keyring.js";

// One name rule for both sides: every key the dashboard API redacts (isSecretKey in
// src/lib/secretRedaction.js: apiKey(s), *Token, *Secret, password, cookie(s),
// authorization / x-api-key / x-goog-api-key headers, ...) is also encrypted at rest.
// On top of it, fields whose value is a URL that can embed user:pass or a deploy token
// (responses mask the userinfo instead of hiding the field), the already-encrypted
// MITM sudo password (the settings route strips it explicitly), and the AWS access key id
// (shown in the provider form so it can be edited; half of the AWS credential pair).
export const AT_REST_ONLY_FIELDS = new Set([
  "proxyUrl",
  "connectionProxyUrl",
  "outboundProxyUrl",
  "updateWebhookUrl",
  "mitmSudoEncrypted",
  "accessKeyId",
]);

export function isSecretField(name) {
  return AT_REST_ONLY_FIELDS.has(name) || isSecretKey(name);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Visits every credential string in `v`, recursing through objects and arrays:
 * fn(value, path) returns the replacement. A string is a credential when its own key is
 * secret-named or when it sits anywhere below a secret-named key (an array of keys, an
 * object of tokens).
 */
function mapSecrets(v, fn, path = "", secret = false) {
  if (typeof v === "string") return secret && v !== "" ? fn(v, path) : v;
  if (Array.isArray(v)) return v.map((x, i) => mapSecrets(x, fn, `${path}[${i}]`, secret));
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = mapSecrets(x, fn, path ? `${path}.${k}` : k, secret || isSecretField(k));
  }
  return out;
}

/** Encrypts every credential field (re-encrypts envelopes under an older key). `where` = { table, column, id }. */
// `plaintextOnly` leaves every existing envelope alone (used on old backups, whose keys may be gone).
export function sealSecrets(obj, where, ring = getKeyring(), { plaintextOnly = false } = {}) {
  return mapSecrets(obj, (v, path) => {
    const ctx = { ...where, path };
    if (isEnvelope(v)) {
      if (plaintextOnly || envelopeKeyId(v) === ring.currentId) return v;
      return encryptValue(decryptValue(v, ctx, ring), ctx, ring);
    }
    return encryptValue(v, ctx, ring);
  });
}

/**
 * Decrypts every credential field. A plaintext value is returned as-is: that only happens
 * between an older version writing it (after a downgrade) and the next boot's heal, which
 * encrypts it (db/helpers/credentialsSeal.js). This is confidentiality at rest, not
 * integrity against someone who can write the DB file: such a writer can always plant a
 * plaintext value, which is read as-is until the heal seals it.
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
