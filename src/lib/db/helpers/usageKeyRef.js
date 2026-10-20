// Usage rows never store a client's raw API key. They store a key reference:
//   - "id:<apiKeys.id>" when the key is known (it stays that after the key is deleted), or
//   - "key-<16 hex>" (first 64 bits of SHA-256 of the trimmed key) for a key that is
//     not in apiKeys (deleted before the backfill ran, or never issued). Stable, so
//     history still aggregates per key, and not reversible for generated keys.
// apiKeys is the only table that holds key strings.
import { createHash } from "node:crypto";
import { parseJson, stringifyJson } from "./jsonCol.js";

export const NO_KEY_BUCKET = "local-no-key";
const HASHED_REF_RE = /^key-[0-9a-f]{16}$/;
const ID_PREFIX = "id:";

export function hashedKeyRef(rawKey) {
  return `key-${createHash("sha256").update(String(rawKey).trim()).digest("hex").slice(0, 16)}`;
}

export const isHashedKeyRef = (ref) => typeof ref === "string" && HASHED_REF_RE.test(ref);

/** Reference for an apiKeys.id. */
export const keyRefForId = (id) => `${ID_PREFIX}${id}`;

/** The apiKeys.id a reference points at (the key may since have been deleted), else null. */
export const keyIdFromRef = (ref) =>
  typeof ref === "string" && ref.startsWith(ID_PREFIX) ? ref.slice(ID_PREFIX.length) : null;

/** True for a stored reference, false for anything else (a raw key). */
export const isKeyRef = (v) => isHashedKeyRef(v) || (typeof v === "string" && v.startsWith(ID_PREFIX) && v.length > ID_PREFIX.length);

/** Key reference for a raw key string (sync, `db` is an adapter). Null when there's no key. */
export function usageKeyRef(db, rawKey) {
  if (typeof rawKey !== "string") return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const row = db.get(`SELECT id FROM apiKeys WHERE key = ? OR key = ? LIMIT 1`, [rawKey, trimmed]);
  return row ? keyRefForId(row.id) : hashedKeyRef(trimmed);
}

/** Value already stored in usage → its reference. Refs pass through, raw keys are converted. */
function toRef(db, value, cache) {
  if (cache.has(value)) return cache.get(value);
  const ref = isKeyRef(value) ? value : usageKeyRef(db, value);
  cache.set(value, ref);
  return ref;
}

const SUM_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens", "cost", "credits", "creditCost"];

function mergeBucket(into, from) {
  const charge = (into.charge ?? into.cost ?? 0) + (from.charge ?? from.cost ?? 0);
  for (const f of SUM_FIELDS) into[f] = (into[f] || 0) + (from[f] || 0);
  into.charge = charge;
}

/** One day's byApiKey with every bucket keyed by reference. Returns null when nothing changed. */
function rekeyDay(db, byApiKey, cache) {
  let changed = false;
  const out = {};
  for (const [bucketId, bucket] of Object.entries(byApiKey || {})) {
    const sep = bucketId.indexOf("|");
    const idPart = sep < 0 ? bucketId : bucketId.slice(0, sep);
    const rest = sep < 0 ? "" : bucketId.slice(sep);
    const b = { ...bucket };
    let ref;
    if (idPart === NO_KEY_BUCKET) ref = null;
    else if (typeof b.keyRef === "string" && b.apiKey === undefined) ref = b.keyRef;
    else ref = toRef(db, typeof b.apiKey === "string" && b.apiKey ? b.apiKey : idPart, cache);
    if ("apiKey" in b) { delete b.apiKey; changed = true; }
    if (ref) {
      if (b.keyRef !== ref) { b.keyRef = ref; changed = true; }
    }
    const newId = ref ? `${ref}${rest}` : bucketId;
    if (newId !== bucketId) changed = true;
    if (out[newId]) { mergeBucket(out[newId], b); changed = true; }
    else out[newId] = b;
  }
  return changed ? out : null;
}

const hasTable = (db, name) =>
  !!db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);

/**
 * Replace raw keys in usageHistory.apiKey and usageDaily.data.byApiKey with key
 * references. Idempotent: refs are left as they are. Returns how many rows changed.
 */
export function backfillUsageKeyRefs(db) {
  const cache = new Map();
  let history = 0;
  let daily = 0;
  if (!hasTable(db, "apiKeys")) return { history, daily };
  if (hasTable(db, "usageHistory")) {
    for (const { apiKey } of db.all(`SELECT DISTINCT apiKey FROM usageHistory WHERE apiKey IS NOT NULL`)) {
      const ref = typeof apiKey === "string" ? toRef(db, apiKey, cache) : null;
      if (ref === apiKey) continue;
      const res = db.run(`UPDATE usageHistory SET apiKey = ? WHERE apiKey = ?`, [ref, apiKey]);
      history += res?.changes ?? 0;
    }
  }
  if (hasTable(db, "usageDaily")) {
    for (const row of db.all(`SELECT dateKey, data FROM usageDaily`)) {
      const day = parseJson(row.data, null);
      if (!day || typeof day !== "object" || !day.byApiKey) continue;
      const next = rekeyDay(db, day.byApiKey, cache);
      if (!next) continue;
      day.byApiKey = next;
      db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [stringifyJson(day), row.dateKey]);
      daily++;
    }
  }
  return { history, daily };
}

/** Cheap check for the boot-time heal: is any raw key left in usage? */
export function hasRawUsageKeys(db) {
  if (!hasTable(db, "usageHistory") || !hasTable(db, "apiKeys")) return false;
  const raw = db.get(
    `SELECT 1 AS x FROM usageHistory WHERE apiKey IS NOT NULL
       AND apiKey NOT LIKE 'id:_%'
       AND NOT (apiKey GLOB 'key-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
     LIMIT 1`,
  );
  if (raw) return true;
  if (!hasTable(db, "usageDaily")) return false;
  return !!db.get(`SELECT 1 AS x FROM usageDaily WHERE data LIKE '%"apiKey":%' LIMIT 1`);
}
