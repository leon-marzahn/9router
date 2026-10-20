// Credentials at rest: the tables and JSON columns that hold them, and the boot-time
// passes over them (migration 006, the heal after a downgrade or a key rotation, the
// VACUUM that drops the old plaintext bytes from the file).
import { inspectSecrets, openSecrets, sealSecrets } from "@/lib/credentials/fields.js";
import { ensureCredentialsKey } from "@/lib/credentials/keyring.js";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { getMetaSync, setMetaSync } from "./metaStore.js";

/** Tables whose `data` JSON column holds credentials, keyed by primary key column. */
export const CREDENTIAL_TABLES = [
  { table: "providerConnections", column: "data", pk: "id" },
  { table: "proxyPools", column: "data", pk: "id" },
  { table: "settings", column: "data", pk: "id" },
];

export const KEY_ID_META = "credentialsKeyId";
export const SCRUBBED_META = "credentialsScrubbed";

export const whereOf = (table, id) => ({ table, column: "data", id: String(id) });

/** Seal one row's JSON for writing. */
export const sealRow = (table, id, obj) => sealSecrets(obj, whereOf(table, id));
/** Open one row's JSON after reading. */
export const openRow = (table, id, obj) => openSecrets(obj, whereOf(table, id));

function rowsOf(db, { table, column, pk }) {
  try {
    return db.all(`SELECT ${pk} AS id, ${column} AS data FROM ${table}`);
  } catch {
    return []; // table not created yet (pre-001 DB)
  }
}

/** { plaintext, keyIds } over every credential in the database. */
export function scanCredentials(db) {
  const res = { plaintext: 0, keyIds: new Set() };
  for (const t of CREDENTIAL_TABLES) {
    for (const r of rowsOf(db, t)) {
      const s = inspectSecrets(parseJson(r.data, {}));
      res.plaintext += s.plaintext;
      for (const id of s.keyIds) res.keyIds.add(id);
    }
  }
  const stored = (() => {
    try {
      return getMetaSync(db, KEY_ID_META, null);
    } catch {
      return null;
    }
  })();
  if (stored) res.keyIds.add(stored);
  return res;
}

/**
 * Loads the key for this database, failing closed (see keyring.ensureCredentialsKey).
 * Returns { ring, scan }.
 */
export function loadCredentialsKey(db) {
  const scan = scanCredentials(db);
  const ring = ensureCredentialsKey(scan.keyIds);
  return { ring, scan };
}

/** True when a plaintext credential, or one under a non-current key, is stored. */
export function needsCredentialsSeal(db, ring, scan = scanCredentials(db)) {
  if (scan.plaintext > 0) return true;
  const ids = new Set(scan.keyIds);
  ids.delete(ring.currentId);
  return ids.size > 0;
}

/**
 * Encrypts every plaintext credential and re-encrypts those under an older key, in place.
 * Idempotent: values already under the current key are left byte-for-byte. Marks the
 * file as needing a VACUUM when it rewrote anything. Call inside a transaction.
 */
export function sealAllCredentials(db, ring) {
  let rows = 0;
  let stored = 0;
  for (const t of CREDENTIAL_TABLES) {
    for (const r of rowsOf(db, t)) {
      const obj = parseJson(r.data, null);
      if (!obj || typeof obj !== "object") continue;
      const sealed = sealSecrets(obj, whereOf(t.table, r.id), ring);
      stored += inspectSecrets(sealed).keyIds.size;
      const next = stringifyJson(sealed);
      if (next !== stringifyJson(obj)) {
        db.run(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.pk} = ?`, [next, r.id]);
        rows++;
      }
    }
  }
  // Records which key the stored credentials need, so a later boot without it fails closed.
  if (stored) setMetaSync(db, KEY_ID_META, ring.currentId);
  if (rows) setMetaSync(db, SCRUBBED_META, "0");
  return rows;
}

export function needsCredentialsScrub(db) {
  return getMetaSync(db, SCRUBBED_META, "1") !== "1";
}

/** VACUUM so the overwritten plaintext leaves free pages and the WAL; then record it. */
export function scrubCredentials(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  setMetaSync(db, SCRUBBED_META, "1");
}

export { openSecrets };
