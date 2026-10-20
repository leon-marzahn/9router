import fs from "node:fs";
import path from "node:path";
import { LEGACY_FILES, DB_DIR } from "./paths.js";
import { TABLES, buildCreateTableSql, SCHEMA_VERSION } from "./schema.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import {
  PRE_ENCRYPT_CREDENTIALS,
  PRE_USAGE_KEY_REFS,
  backupDbLite,
  backupFile,
  makeBackupDir,
  pruneOldBackups,
  purgeUnpinnedBackups,
  requiredBackup,
} from "./backup.js";
import {
  KEY_ID_META,
  loadCredentialsKey,
  needsCredentialsScrub,
  needsCredentialsSeal,
  scanCredentials,
  scrubCredentials,
  sealAllCredentials,
} from "./helpers/credentialsSeal.js";

const USAGE_KEY_REFS_VERSION = 5;

/** Thrown when a backup required before rewriting usage keys can't be taken or verified. */
export class BackupRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupRequired";
  }
}

function requiredCredentialsBackup(adapter, label) {
  try {
    return requiredBackup(adapter, label);
  } catch (e) {
    const msg =
      `[DB][migrate] ${e.message}. Refusing to encrypt stored credentials without a verified backup; ` +
      `nothing was changed. Free disk space / fix permissions on DATA_DIR/db and restart.`;
    console.error(msg);
    throw new BackupRequired(msg);
  }
}

function requiredUsageBackup(adapter, label) {
  try {
    return requiredBackup(adapter, label);
  } catch (e) {
    const msg =
      `[DB][migrate] ${e.message}. Refusing to rewrite usage API keys without a verified backup; ` +
      `no usage rows were changed. Free disk space / fix permissions on DATA_DIR/db/backups and restart.`;
    console.error(msg);
    throw new BackupRequired(msg);
  }
}
import { getAppVersion } from "./version.js";
import { stringifyJson } from "./helpers/jsonCol.js";
import { backfillUsageKeyRefs, hasRawUsageKeys, needsUsageScrub, scrubUsageKeys } from "./helpers/usageKeyRef.js";

// Marker file: prevents re-importing legacy JSON when user wipes data.sqlite.
const MIGRATED_MARKER = path.join(DB_DIR, ".migrated-from-json");

// Track per-adapter so reusing same adapter skips re-run, but new adapter (after reset) re-runs.
const _migratedAdapters = new WeakSet();

// Thrown when row-count assertion fails. Outer transaction rolls back,
// legacy db.json kept intact, marker not written → next boot retries.
export class MigrationAborted extends Error {
  constructor(message, droppedRows) {
    super(message);
    this.name = "MigrationAborted";
    this.droppedRows = droppedRows;
  }
}

// Insert rows one-by-one, collect failures, then assert COUNT(*) matches input length.
function importWithAssertion(adapter, tableName, rows, insertFn, rowMeta) {
  const dropped = [];
  for (const row of rows) {
    try { insertFn(row); }
    catch (err) { dropped.push({ ...rowMeta(row), reason: err.message }); }
  }
  const inserted = adapter.get(`SELECT COUNT(*) as c FROM ${tableName}`)?.c ?? 0;
  if (inserted !== rows.length) {
    console.warn(`[DB][migrate] ${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}. Dropped:`, dropped);
    throw new MigrationAborted(`${tableName} row-count mismatch: expected ${rows.length}, got ${inserted}`, dropped);
  }
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function isFreshDb(adapter) {
  // Table _meta may not exist yet on truly fresh DB
  try {
    const row = adapter.get(`SELECT COUNT(*) as c FROM _meta`);
    return !row || row.c === 0;
  } catch {
    return true;
  }
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
function runVersionedMigrations(adapter) {
  // Bootstrap _meta first so we can read schemaVersion
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  const current = parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0;
  const target = latestVersion();
  if (current >= target) return { applied: 0, from: current, to: current };

  const pending = MIGRATIONS.filter((m) => m.version > current);
  let lastApplied = current;
  for (const m of pending) {
    adapter.transaction(() => {
      m.up(adapter);
      setMetaSync(adapter, "schemaVersion", m.version);
    });
    lastApplied = m.version;
    console.log(`[DB][migrate] applied #${m.version} ${m.name}`);
  }
  return { applied: pending.length, from: current, to: lastApplied };
}

// ─── Auto-sync (additive only): add missing tables/columns/indexes ───────
function syncSchemaFromTables(adapter) {
  for (const [tableName, def] of Object.entries(TABLES)) {
    // Create table if absent
    adapter.exec(buildCreateTableSql(tableName, def));

    // Diff columns
    const existing = adapter.all(`PRAGMA table_info(${tableName})`);
    const existingNames = new Set(existing.map((r) => r.name));
    for (const [colName, colDef] of Object.entries(def.columns)) {
      if (!existingNames.has(colName)) {
        // SQLite ADD COLUMN restrictions: no PRIMARY KEY / UNIQUE w/o NULL ok.
        // We strip PRIMARY KEY / UNIQUE since those are only valid at create time.
        const safeDef = colDef
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .trim();
        try {
          adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`);
          console.log(`[DB][sync] +column ${tableName}.${colName}`);
        } catch (e) {
          console.warn(`[DB][sync] add column ${tableName}.${colName} failed: ${e.message}`);
        }
      }
    }

    // Indexes (idempotent)
    for (const idx of def.indexes || []) {
      try { adapter.exec(idx); } catch {}
    }
  }
}

// ─── Legacy JSON import (one-time) ───────────────────────────────────────
function importLegacyMain(adapter, data) {
  if (!data || typeof data !== "object") return;

  if (data.settings) {
    adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(data.settings)]);
  }

  importWithAssertion(adapter, "providerConnections", data.providerConnections || [], (c) => {
    const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
    adapter.run(
      `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }, (c) => ({ id: c.id ?? null, provider: c.provider ?? null, name: c.name ?? null }));

  importWithAssertion(adapter, "providerNodes", data.providerNodes || [], (n) => {
    const { id, type, name, createdAt, updatedAt, ...rest } = n;
    adapter.run(
      `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }, (n) => ({ id: n.id ?? null, type: n.type ?? null, name: n.name ?? null }));

  importWithAssertion(adapter, "proxyPools", data.proxyPools || [], (p) => {
    const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
    adapter.run(
      `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
    );
  }, (p) => ({ id: p.id ?? null }));

  importWithAssertion(adapter, "apiKeys", data.apiKeys || [], (k) => {
    adapter.run(
      `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
    );
  }, (k) => ({ id: k.id ?? null, name: k.name ?? null }));

  importWithAssertion(adapter, "combos", data.combos || [], (c) => {
    adapter.run(
      `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
      [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
    );
  }, (c) => ({ id: c.id ?? null, name: c.name ?? null }));

  for (const [alias, model] of Object.entries(data.modelAliases || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [alias, stringifyJson(model)]);
  }
  for (const m of data.customModels || []) {
    const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
  }
  for (const [tool, mappings] of Object.entries(data.mitmAlias || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
  }
  for (const [provider, models] of Object.entries(data.pricing || {})) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
  }
}

function importLegacyUsage(adapter, data) {
  if (!data || typeof data !== "object") return;
  for (const e of data.history || []) {
    const t = e.tokens || {};
    adapter.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.timestamp || new Date().toISOString(),
        e.provider || null, e.model || null, e.connectionId || null, e.apiKey || null, e.endpoint || null,
        t.prompt_tokens || t.input_tokens || 0,
        t.completion_tokens || t.output_tokens || 0,
        e.cost || 0,
        e.status || "ok",
        stringifyJson(t),
        stringifyJson({}),
      ]
    );
  }
  for (const [dateKey, day] of Object.entries(data.dailySummary || {})) {
    adapter.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, stringifyJson(day)]);
  }
  if (typeof data.totalRequestsLifetime === "number") {
    setMetaSync(adapter, "totalRequestsLifetime", data.totalRequestsLifetime);
  }
}

function importLegacyDisabled(adapter, data) {
  if (!data || typeof data.disabled !== "object") return;
  for (const [provider, ids] of Object.entries(data.disabled)) {
    adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('disabledModels', ?, ?)`, [provider, stringifyJson(ids || [])]);
  }
}

function importLegacyDetails(adapter, data) {
  if (!data || !Array.isArray(data.records)) return;
  for (const r of data.records) {
    adapter.run(
      `INSERT OR REPLACE INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.timestamp || new Date().toISOString(), r.provider || null, r.model || null, r.connectionId || null, r.status || null, stringifyJson(r)]
    );
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────
export async function runMigrationOnce(adapter) {
  if (_migratedAdapters.has(adapter)) return;
  _migratedAdapters.add(adapter);
  const bootStartedMs = Date.now();

  // Capture freshness BEFORE migrations stamp _meta (otherwise we'd misclassify
  // a brand-new DB as non-fresh once schemaVersion is written).
  const fresh = isFreshDb(adapter);

  // Prune stale backups every boot so old oversized backups shrink to KEEP.
  pruneOldBackups();

  // Bootstrap _meta so we can read the stored backup schema version below
  // (runVersionedMigrations also ensures this, but we need it earlier here).
  adapter.exec(buildCreateTableSql("_meta", TABLES._meta));

  // Detect a pending schema change via the central SCHEMA_VERSION const.
  // A lightweight backup is taken BEFORE any schema mutation below.
  const storedSchemaVer = parseInt(getMetaSync(adapter, "backupSchemaVersion", "0"), 10) || 0;

  // Credentials key (src/lib/credentials): fails closed before anything is written when the
  // DB holds envelopes and the key is missing or wrong. Generated only for a DB without any.
  const { ring, scan: credScan } = loadCredentialsKey(adapter);
  const credentialsPending = !fresh && needsCredentialsSeal(adapter, ring, credScan);
  const schemaChanging = !fresh && storedSchemaVer < SCHEMA_VERSION;
  // Migration 005 rewrites usage rows one way: its backup is required (taken, verified,
  // pinned against pruning). If it can't be taken, the boot stops here, untouched.
  const usageRefsPending =
    !fresh && (parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0) < USAGE_KEY_REFS_VERSION;
  let backedUp = false;
  if (usageRefsPending) {
    const dir = requiredUsageBackup(adapter, PRE_USAGE_KEY_REFS);
    pruneOldBackups();
    backedUp = true;
    console.log(`[DB][migrate] pre-usage-key-refs backup (pinned, verified): ${dir}`);
  }
  // Migration 006 / the heal encrypt plaintext credentials (or re-encrypt them under a new
  // key) one way: a verified backup first. The plaintext one is pinned and holds the
  // credentials unencrypted.
  if (credentialsPending) {
    const label = credScan.plaintext > 0 ? PRE_ENCRYPT_CREDENTIALS : "pre-credentials-rekey";
    const dir = requiredCredentialsBackup(adapter, label);
    pruneOldBackups();
    backedUp = true;
    console.log(`[DB][migrate] ${label} backup (verified${label === PRE_ENCRYPT_CREDENTIALS ? ", pinned, holds plaintext credentials" : ""}): ${dir}`);
  }
  if (!backedUp && schemaChanging) {
    try {
      const backupDir = makeBackupDir(`schema-${storedSchemaVer}-to-${SCHEMA_VERSION}`);
      backupDbLite(adapter, backupDir);
      pruneOldBackups();
      console.log(`[DB][migrate] pre-schema backup ${storedSchemaVer} → ${SCHEMA_VERSION}: ${backupDir}`);
    } catch (e) {
      console.warn(`[DB][migrate] pre-schema backup failed (continuing): ${e.message}`);
    }
  }

  // 1. Always run versioned migrations chain (skip-version safe)
  const migInfo = runVersionedMigrations(adapter);

  // 2. Additive sync (auto add missing columns/indexes declared in TABLES)
  syncSchemaFromTables(adapter);

  // Usage rows hold key references, never raw keys (migration 005). Rows written by an
  // older version after a downgrade bring raw keys back: convert them again, after a
  // required backup of their own (a failed backup stops the boot before any rewrite).
  if (hasRawUsageKeys(adapter)) {
    if (!backedUp) {
      const dir = requiredUsageBackup(adapter, "pre-usage-key-heal");
      pruneOldBackups();
      backedUp = true;
      console.log(`[DB][migrate] pre-usage-key-heal backup (verified): ${dir}`);
    }
    try {
      const healed = adapter.transaction(() => backfillUsageKeyRefs(adapter));
      console.log(`[DB][migrate] usage key refs restored (${healed?.history ?? 0} history rows, ${healed?.daily ?? 0} days)`);
    } catch (e) {
      console.warn(`[DB][migrate] usage key ref backfill failed: ${e.message}`);
    }
  }
  // Overwritten rows leave the old key strings in free pages and the WAL until they are
  // reused. The backfill sets usageKeysScrubbed = 0 in the same transaction as its
  // rewrite; it turns 1 only after a VACUUM succeeds, so a crash in between retries.
  if (needsUsageScrub(adapter)) {
    if (!backedUp) {
      const dir = requiredUsageBackup(adapter, "pre-usage-key-scrub");
      pruneOldBackups();
      console.log(`[DB][migrate] pre-usage-key-scrub backup (verified): ${dir}`);
    }
    try {
      scrubUsageKeys(adapter);
      console.log("[DB][migrate] vacuumed after usage key refs");
    } catch (e) {
      console.warn(`[DB][migrate] vacuum after usage key refs failed (retried next boot): ${e.message}`);
    }
  }

  // Credentials are stored encrypted (migration 006). Plaintext written by an older version
  // after a downgrade, or values under a rotated-out key, are sealed again here, after the
  // backup above. A value that fails authentication throws: the boot stops, nothing changes.
  if (needsCredentialsSeal(adapter, ring)) {
    if (!backedUp) {
      const dir = requiredCredentialsBackup(adapter, PRE_ENCRYPT_CREDENTIALS);
      pruneOldBackups();
      backedUp = true;
      console.log(`[DB][migrate] pre-credentials-heal backup (verified, pinned): ${dir}`);
    }
    const n = adapter.transaction(() => sealAllCredentials(adapter, ring));
    console.log(`[DB][migrate] credentials encrypted (${n ?? 0} rows)`);
  }
  if (scanCredentials(adapter).keyIds.size && getMetaSync(adapter, KEY_ID_META, null) !== ring.currentId) {
    setMetaSync(adapter, KEY_ID_META, ring.currentId);
  }
  // The rewrite leaves plaintext in free pages and the WAL until a VACUUM; the seal sets
  // credentialsScrubbed = 0 in its transaction and it turns 1 only after the VACUUM, so a
  // crash in between retries. Older unpinned backups hold the same plaintext: removed too
  // (the pinned pre-encrypt-credentials backup is the newer copy).
  if (needsCredentialsScrub(adapter)) {
    try {
      scrubCredentials(adapter);
      const removed = purgeUnpinnedBackups(bootStartedMs);
      console.log(`[DB][migrate] vacuumed after encrypting credentials; removed ${removed} older unencrypted backup(s)`);
    } catch (e) {
      console.warn(`[DB][migrate] vacuum after encrypting credentials failed (retried next boot): ${e.message}`);
    }
  }

  // Stamp the schema version we just reached so future boots skip re-backup.
  setMetaSync(adapter, "backupSchemaVersion", SCHEMA_VERSION);

  // 3. One-time legacy JSON import (only if DB was fresh on entry)
  const alreadyImported = fs.existsSync(MIGRATED_MARKER);
  const legacyMain = readJsonSafe(LEGACY_FILES.main);
  const legacyUsage = readJsonSafe(LEGACY_FILES.usage);
  const legacyDisabled = readJsonSafe(LEGACY_FILES.disabled);
  const legacyDetails = readJsonSafe(LEGACY_FILES.details);
  const hasLegacy = !!(legacyMain || legacyUsage || legacyDisabled || legacyDetails);

  if (fresh && hasLegacy && !alreadyImported) {
    const t0 = Date.now();
    const backupDir = makeBackupDir("migrate-from-json");
    for (const f of Object.values(LEGACY_FILES)) backupFile(f, backupDir);

    try {
      adapter.transaction(() => {
        importLegacyMain(adapter, legacyMain);
        importLegacyUsage(adapter, legacyUsage);
        importLegacyDisabled(adapter, legacyDisabled);
        importLegacyDetails(adapter, legacyDetails);
        backfillUsageKeyRefs(adapter, { allRaw: true });
        sealAllCredentials(adapter, ring);
        setMetaSync(adapter, "appVersion", getAppVersion());
        setMetaSync(adapter, "backupSchemaVersion", SCHEMA_VERSION);
        setMetaSync(adapter, "migratedAt", new Date().toISOString());
      });
    } catch (err) {
      if (err instanceof MigrationAborted) {
        console.error(`[DB][migrate] aborted: ${err.message} | legacy JSON kept | backup: ${backupDir}`);
        return;
      }
      throw err;
    }

    try { fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString()); } catch {}
    try { if (needsCredentialsScrub(adapter)) scrubCredentials(adapter); } catch {}
    console.warn("[DB][migrate] the legacy JSON files in DATA_DIR still hold provider credentials in plaintext; delete them once the import is checked");
    pruneOldBackups();
    console.log(`[DB][migrate] JSON → SQLite in ${Date.now() - t0}ms | legacy JSON kept at DATA_DIR | backup: ${backupDir}`);
    return;
  }

  // Track app version for informational purposes only. App version bumps no
  // longer trigger a DB backup — only real schema changes (SCHEMA_VERSION) do.
  const newVer = getAppVersion();
  const oldVer = getMetaSync(adapter, "appVersion", null);
  if (oldVer !== newVer) setMetaSync(adapter, "appVersion", newVer);
}
