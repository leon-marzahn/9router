// Usage rows never store a client's raw API key. They store a key reference:
//   - "id:<apiKeys.id>" for a key that exists in apiKeys, or
//   - "key-<16 hex>" (first 64 bits of SHA-256 of the trimmed key) for a key that is
//     not in apiKeys: never issued, or deleted (deleteApiKey retires its "id:" refs
//     to this hash). Stable, so history still aggregates per key, and not reversible
//     for generated keys.
// Invariant: every "id:" ref names an existing key. A stored "id:" value that doesn't
// is not trusted as a ref (a client could have sent it as its key); it is hashed.
// apiKeys is the only table that holds key strings.
import { createHash } from "node:crypto";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { getMetaSync, setMetaSync } from "./metaStore.js";

export const NO_KEY_BUCKET = "local-no-key";
const HASHED_REF_RE = /^key-[0-9a-f]{16}$/;
const ID_PREFIX = "id:";
/** _meta flag: "1" once the file has been vacuumed after raw keys were rewritten. */
export const SCRUBBED_META_KEY = "usageKeysScrubbed";

export function hashedKeyRef(rawKey) {
  return `key-${createHash("sha256").update(String(rawKey).trim()).digest("hex").slice(0, 16)}`;
}

export const isHashedKeyRef = (ref) => typeof ref === "string" && HASHED_REF_RE.test(ref);

/** Reference for an apiKeys.id. */
export const keyRefForId = (id) => `${ID_PREFIX}${id}`;

/** The apiKeys.id an "id:" reference points at, else null. */
export const keyIdFromRef = (ref) =>
  typeof ref === "string" && ref.startsWith(ID_PREFIX) ? ref.slice(ID_PREFIX.length) : null;

/** Shape check only: does this look like a stored reference? */
export const isKeyRef = (v) =>
  isHashedKeyRef(v) || (typeof v === "string" && v.startsWith(ID_PREFIX) && v.length > ID_PREFIX.length);

/** A stored value that is a real reference: a hash, or "id:" of a key that exists. */
function isValidRef(db, v) {
  if (isHashedKeyRef(v)) return true;
  const id = keyIdFromRef(v);
  return !!id && !!db.get(`SELECT 1 AS x FROM apiKeys WHERE id = ?`, [id]);
}

/** Key reference for a raw key string (sync, `db` is an adapter). Null when there's no key. */
export function usageKeyRef(db, rawKey) {
  if (typeof rawKey !== "string") return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const row = db.get(`SELECT id FROM apiKeys WHERE key = ? OR key = ? LIMIT 1`, [rawKey, trimmed]);
  return row ? keyRefForId(row.id) : hashedKeyRef(trimmed);
}

const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost", "credits", "creditCost"];

function mergeBucket(into, from) {
  const charge = (into.charge ?? into.cost ?? 0) + (from.charge ?? from.cost ?? 0);
  for (const f of SUM_FIELDS) into[f] = (into[f] || 0) + (from[f] || 0);
  into.charge = charge;
}

/**
 * One day's byApiKey with every bucket re-keyed by `mapValue(storedValue)` → ref.
 * The stored value is the bucket's raw `apiKey` (pre-005), else its `keyRef`, else the
 * bucket id's key part. Returns null when nothing changed.
 */
function rekeyDay(byApiKey, mapValue) {
  let changed = false;
  const out = {};
  for (const [bucketId, bucket] of Object.entries(byApiKey || {})) {
    const sep = bucketId.indexOf("|");
    const idPart = sep < 0 ? bucketId : bucketId.slice(0, sep);
    const rest = sep < 0 ? "" : bucketId.slice(sep);
    const b = { ...bucket };
    let ref = null;
    if (idPart !== NO_KEY_BUCKET) {
      const stored =
        typeof b.apiKey === "string" && b.apiKey ? b.apiKey : typeof b.keyRef === "string" && b.keyRef ? b.keyRef : idPart;
      ref = mapValue(stored);
    }
    if ("apiKey" in b) {
      delete b.apiKey;
      changed = true;
    }
    if (ref && b.keyRef !== ref) {
      b.keyRef = ref;
      changed = true;
    }
    const newId = ref ? `${ref}${rest}` : bucketId;
    if (newId !== bucketId) changed = true;
    if (out[newId]) {
      mergeBucket(out[newId], b);
      changed = true;
    } else out[newId] = b;
  }
  return changed ? out : null;
}

const hasTable = (db, name) =>
  !!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);

function rewriteUsage(db, mapValue, historyValues) {
  let history = 0;
  let daily = 0;
  if (hasTable(db, "usageHistory")) {
    for (const apiKey of historyValues) {
      const ref = mapValue(apiKey);
      if (ref === apiKey) continue;
      const res = db.run(`UPDATE usageHistory SET apiKey = ? WHERE apiKey = ?`, [ref, apiKey]);
      history += res?.changes ?? 0;
    }
  }
  if (hasTable(db, "usageDaily")) {
    for (const row of db.all(`SELECT dateKey, data FROM usageDaily`)) {
      const day = parseJson(row.data, null);
      if (!day || typeof day !== "object" || !day.byApiKey) continue;
      const next = rekeyDay(day.byApiKey, mapValue);
      if (!next) continue;
      day.byApiKey = next;
      db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [stringifyJson(day), row.dateKey]);
      daily++;
    }
  }
  if (history || daily) setMetaSync(db, SCRUBBED_META_KEY, "0");
  return { history, daily };
}

/**
 * Replace raw keys in usageHistory.apiKey and usageDaily.data.byApiKey with key
 * references. Valid refs are kept (idempotent). `allRaw` (migration 005, before any
 * ref existed) treats every stored value as a raw key, including ref-shaped ones.
 * Marks the DB as needing a VACUUM when it changed anything. Returns rows changed.
 */
export function backfillUsageKeyRefs(db, { allRaw = false } = {}) {
  if (!hasTable(db, "apiKeys")) return { history: 0, daily: 0 };
  const cache = new Map();
  const mapValue = (value) => {
    if (typeof value !== "string") return null;
    if (cache.has(value)) return cache.get(value);
    const ref = !allRaw && isValidRef(db, value) ? value : usageKeyRef(db, value);
    cache.set(value, ref);
    return ref;
  };
  const values = hasTable(db, "usageHistory")
    ? db.all(`SELECT DISTINCT apiKey FROM usageHistory WHERE apiKey IS NOT NULL`).map((r) => r.apiKey)
    : [];
  return rewriteUsage(db, mapValue, values);
}

/**
 * Before a key is deleted: its "id:" refs become the hash of its key string, so the
 * invariant (every "id:" ref names an existing key) holds and its history stays grouped.
 */
export function retireKeyRef(db, id, rawKey) {
  if (typeof rawKey !== "string" || !rawKey.trim()) return { history: 0, daily: 0 };
  const from = keyRefForId(id);
  const to = hashedKeyRef(rawKey);
  const before = getMetaSync(db, SCRUBBED_META_KEY, "1");
  const res = rewriteUsage(db, (v) => (v === from ? to : v), [from]);
  // Only ids were rewritten, never a key string: this alone needs no VACUUM.
  setMetaSync(db, SCRUBBED_META_KEY, before);
  return res;
}

/** Boot-time check: does usage hold anything that isn't a valid reference? */
export function hasRawUsageKeys(db) {
  if (!hasTable(db, "usageHistory") || !hasTable(db, "apiKeys")) return false;
  const raw = db.get(
    `SELECT 1 AS x FROM usageHistory WHERE apiKey IS NOT NULL
       AND apiKey NOT IN (SELECT 'id:' || id FROM apiKeys)
       AND NOT (apiKey GLOB 'key-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
     LIMIT 1`,
  );
  if (raw) return true;
  if (!hasTable(db, "usageDaily")) return false;
  for (const row of db.all(`SELECT data FROM usageDaily`)) {
    const day = parseJson(row.data, null);
    for (const [bucketId, b] of Object.entries(day?.byApiKey || {})) {
      if (bucketId.startsWith(`${NO_KEY_BUCKET}|`) || bucketId === NO_KEY_BUCKET) continue;
      if (b && "apiKey" in b) return true;
      if (!isValidRef(db, b?.keyRef)) return true;
    }
  }
  return false;
}

/** True when raw keys were rewritten and the file hasn't been vacuumed since. */
export function needsUsageScrub(db) {
  return getMetaSync(db, SCRUBBED_META_KEY, "1") !== "1";
}

/** VACUUM so rewritten key bytes leave free pages and the WAL; then record it. */
export function scrubUsageKeys(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  setMetaSync(db, SCRUBBED_META_KEY, "1");
}
