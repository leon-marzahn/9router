// Versioned AES-256-GCM envelope for one stored credential string:
//   enc:v1:<keyId>:<iv>:<tag>:<ciphertext>      (iv, tag, ciphertext base64url)
// The AAD binds the value to where it is stored (table, column, row id, JSON path), so a
// ciphertext copied into another row or field fails authentication.
import crypto from "node:crypto";
import { CredentialsKeyError, getKeyring } from "./keyring.js";

export const ENVELOPE_PREFIX = "enc:v1:";
const ENVELOPE_RE =
  /^enc:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$/;

export function isEnvelope(v) {
  return typeof v === "string" && v.startsWith(ENVELOPE_PREFIX);
}

/** Key id of an envelope, or null. */
export function envelopeKeyId(v) {
  return isEnvelope(v) ? v.slice(ENVELOPE_PREFIX.length).split(":")[0] : null;
}

export function aadFor({ table, column, id, path }) {
  return Buffer.from(`regent:${table}:${column}:${id}:${path}`, "utf8");
}

export function encryptValue(plaintext, ctx, ring = getKeyring()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ring.current, iv);
  cipher.setAAD(aadFor(ctx));
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${ring.currentId}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Decrypts an envelope. Throws CredentialsKeyError (no key) or Error (tampered/misplaced); never returns garbage. */
export function decryptValue(envelope, ctx, ring = getKeyring()) {
  const m = ENVELOPE_RE.exec(envelope);
  if (!m)
    throw new Error(
      `Malformed credential envelope at ${ctx.table}.${ctx.column}[${ctx.id}].${ctx.path}`,
    );
  const [, keyId, iv, tag, ct] = m;
  const key = ring.keys.get(keyId);
  if (!key) {
    throw new CredentialsKeyError(
      `No credentials key with id ${keyId} for ${ctx.table}.${ctx.column}[${ctx.id}].${ctx.path}`,
    );
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(aadFor(ctx));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      `Credential failed authentication at ${ctx.table}.${ctx.column}[${ctx.id}].${ctx.path} (tampered or moved)`,
    );
  }
}
