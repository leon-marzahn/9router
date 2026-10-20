// Credentials encryption key (AES-256, 32 bytes). Node-only: never import this from
// code that can run in the Edge runtime.
//
// Sources, in order:
//   current:  CREDENTIALS_KEY (base64/base64url/hex), else DATA_DIR/credentials.key
//   previous: CREDENTIALS_KEY_PREVIOUS (comma-separated), plus one key per line in
//             DATA_DIR/credentials.key.previous (rotation: decrypt-only)
// The key file is created (mode 0600) only by ensureCredentialsKey, and only when the
// database holds no encrypted value yet. It is never stored inside the database.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const KEY_FILE = path.join(DATA_DIR, "credentials.key");
export const PREVIOUS_KEY_FILE = path.join(DATA_DIR, "credentials.key.previous");

/** Thrown when the key is missing, malformed, or doesn't match the stored ciphertext. */
export class CredentialsKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialsKeyError";
  }
}

if (!global._credentialsKeyring) global._credentialsKeyring = { ring: null };
const state = global._credentialsKeyring;

/** Decodes a 32-byte key written as hex (64 chars) or base64/base64url. Throws otherwise. */
export function parseKey(text, source) {
  const s = String(text ?? "").trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s))
    buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buf || buf.length !== 32) {
    throw new CredentialsKeyError(
      `${source}: not a 32-byte key (expected 64 hex chars or 44 base64 chars)`,
    );
  }
  return buf;
}

/** Short public fingerprint of a key, stored in each envelope so rotation can pick the key. */
export function keyIdOf(key) {
  return crypto
    .createHash("sha256")
    .update("regent-credentials-key-id\0")
    .update(key)
    .digest("base64url")
    .slice(0, 11);
}

export function generateKeyText() {
  return crypto.randomBytes(32).toString("base64");
}

function readFileKeys(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => parseKey(l, file));
}

function warnLoosePerms(file) {
  if (process.platform === "win32") return;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077)
      console.warn(`[Credentials] ${file} is mode ${mode.toString(8)}; run: chmod 600 ${file}`);
  } catch {}
}

/** Reads the keys from env and DATA_DIR. Returns { current, currentId, keys: Map<id, key>, source } (current may be null). */
export function readKeyring() {
  let current = null;
  let source = null;
  if (process.env.CREDENTIALS_KEY) {
    current = parseKey(process.env.CREDENTIALS_KEY, "CREDENTIALS_KEY");
    source = "CREDENTIALS_KEY";
  } else if (fs.existsSync(KEY_FILE)) {
    [current] = readFileKeys(KEY_FILE);
    if (!current) throw new CredentialsKeyError(`${KEY_FILE} is empty`);
    warnLoosePerms(KEY_FILE);
    source = KEY_FILE;
  }
  const previous = [
    ...String(process.env.CREDENTIALS_KEY_PREVIOUS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseKey(s, "CREDENTIALS_KEY_PREVIOUS")),
    ...readFileKeys(PREVIOUS_KEY_FILE),
  ];
  const keys = new Map();
  for (const k of previous) keys.set(keyIdOf(k), k);
  if (current) keys.set(keyIdOf(current), current);
  return { current, currentId: current ? keyIdOf(current) : null, keys, source };
}

/** Writes a new key file (0600, exclusive create). */
export function writeKeyFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

/**
 * Loads the keyring for a database whose envelopes use `storedKeyIds` (from the DB).
 * Fails closed: a database with encrypted values never gets a fresh key, and every key id
 * it uses must be in the keyring. Generates DATA_DIR/credentials.key only for a DB with
 * no encrypted value.
 */
export function ensureCredentialsKey(storedKeyIds = new Set()) {
  let ring = readKeyring();
  if (!ring.current) {
    if (storedKeyIds.size) {
      throw new CredentialsKeyError(
        `The database holds encrypted credentials but no key was found. Set CREDENTIALS_KEY or restore ${KEY_FILE} ` +
          `from your backup. Nothing was changed.`,
      );
    }
    writeKeyFile(KEY_FILE, generateKeyText());
    ring = readKeyring();
    console.warn(
      `[Credentials] ==================================================================\n` +
        `[Credentials] Generated a new credentials encryption key: ${KEY_FILE}\n` +
        `[Credentials] Provider credentials in the database are encrypted with it.\n` +
        `[Credentials] BACK IT UP TOGETHER WITH THE DATABASE: without it the stored\n` +
        `[Credentials] credentials can't be read. (Or set CREDENTIALS_KEY instead.)\n` +
        `[Credentials] ==================================================================`,
    );
  }
  const missing = [...storedKeyIds].filter((id) => !ring.keys.has(id));
  if (missing.length) {
    throw new CredentialsKeyError(
      `Wrong credentials key: the database was encrypted with key id ${missing.join(", ")}, but ${ring.source} ` +
        `is key id ${ring.currentId}. Set the original CREDENTIALS_KEY (or its file), or list the old key in ` +
        `CREDENTIALS_KEY_PREVIOUS to rotate. Nothing was changed.`,
    );
  }
  state.ring = ring;
  return ring;
}

/** The loaded keyring; loads it read-only (no generation) when boot hasn't. */
export function getKeyring() {
  if (!state.ring) {
    const ring = readKeyring();
    if (!ring.current)
      throw new CredentialsKeyError(
        "No credentials key loaded (CREDENTIALS_KEY or DATA_DIR/credentials.key)",
      );
    state.ring = ring;
  }
  return state.ring;
}

/** Test hook: forget the cached keyring. */
export function resetKeyringCache() {
  state.ring = null;
}
