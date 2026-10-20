// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically,
//   except pinned ones (PINNED_BACKUP_LABELS), stored in db/pinned-backups, never pruned.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, PINNED_BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

const KEEP_BACKUPS = 3;

// Backups that must survive pruning: the last copy of data before a one-way migration.
// They live in PINNED_BACKUPS_DIR (db/pinned-backups), outside db/backups, because older
// releases prune every folder in db/backups and a downgrade would delete them.
export const PRE_USAGE_KEY_REFS = "pre-usage-key-refs";
const PINNED_BACKUP_LABELS = [PRE_USAGE_KEY_REFS];
const isPinned = (name) => PINNED_BACKUP_LABELS.some((l) => name.startsWith(`${l}-`));

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(isPinned(slug) ? PINNED_BACKUPS_DIR : BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

// Lightweight DB backup via ATTACH: create an empty sqlite file, copy every
// table EXCEPT the excluded ones into it. Avoids duplicating the huge
// observability log, so the backup stays small regardless of DB size.
export function backupDbLite(adapter, destDir, destName = "data.sqlite") {
  const dest = path.join(destDir, destName);
  try { fs.rmSync(dest, { force: true }); } catch {}
  const escaped = dest.replace(/'/g, "''");

  adapter.exec(`ATTACH DATABASE '${escaped}' AS bak`);
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = adapter
      .all(`SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .filter((t) => !excluded.has(t.name));

    adapter.transaction(() => {
      for (const t of tables) {
        // Recreate table structure in backup DB, then copy rows.
        const createSql = t.sql.replace(/CREATE TABLE\s+/i, "CREATE TABLE bak.");
        adapter.exec(createSql);
        adapter.exec(`INSERT INTO bak.${t.name} SELECT * FROM main.${t.name}`);
      }
    });
  } finally {
    try { adapter.exec("DETACH DATABASE bak"); } catch {}
  }
  return dest;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isPinned(e.name))
    .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Checks a backup against the live DB, table by table: the copy passes integrity_check,
 * has the same columns and row count, and the usage tables match on an aggregate
 * (SUM(cost) and distinct key refs; total JSON length). Throws on any mismatch.
 * `copyScalar(sql)` runs `sql` on the copy and returns its first value; `ref(t)` names
 * table `t` in that SQL; `columnsSql(t)` lists its columns.
 */
function checkCopy(adapter, tables, { copyScalar, ref, columnsSql }) {
  const integrity = copyScalar("integrity");
  if (integrity !== "ok") throw new Error(`backup integrity_check: ${integrity}`);
  const live = (sql) => {
    const row = adapter.get(sql);
    return row ? Object.values(row)[0] : undefined;
  };
  const probes = (t) => [
    ["columns", (r) => columnsSql(t, r)],
    ["rows", (r) => `SELECT COUNT(*) FROM ${r}`],
    ...(USAGE_AGGREGATES[t] || []).map(([name, expr]) => [name, (r) => `SELECT ${expr} FROM ${r}`]),
  ];
  for (const t of tables) {
    for (const [name, sql] of probes(t)) {
      const want = live(sql(`main.${t}`));
      const got = copyScalar(sql(ref(t)));
      if (String(want) !== String(got)) throw new Error(`backup ${t} ${name}: ${got}, live DB has ${want}`);
    }
  }
}

const USAGE_AGGREGATES = {
  usageHistory: [
    ["cost", "printf('%.6f', COALESCE(SUM(cost), 0))"],
    ["keys", "COUNT(DISTINCT apiKey)"],
  ],
  usageDaily: [["data", "COALESCE(SUM(length(data)), 0)"]],
};

const columnsOf = (schema) => (t) =>
  `SELECT group_concat(name || ':' || type, ',') FROM (SELECT name, type FROM pragma_table_info('${t}'${schema ? `, '${schema}'` : ""}) ORDER BY cid)`;

const backedUpTables = (adapter, excluded) =>
  adapter
    .all(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .map((t) => t.name)
    .filter((n) => !excluded.has(n));

export function verifyBackup(adapter, dest) {
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`backup file missing: ${dest}`);
  const escaped = dest.replace(/'/g, "''");
  adapter.exec(`ATTACH DATABASE '${escaped}' AS chk`);
  try {
    const liveCols = columnsOf("main");
    const chkCols = columnsOf("chk");
    checkCopy(adapter, backedUpTables(adapter, new Set(BACKUP_EXCLUDE_TABLES)), {
      ref: (t) => `chk.${t}`,
      columnsSql: (t, r) => (r.startsWith("chk.") ? chkCols(t) : liveCols(t)),
      copyScalar: (sql) => {
        const row = adapter.get(sql === "integrity" ? "PRAGMA chk.integrity_check" : sql);
        return row ? Object.values(row)[0] : undefined;
      },
    });
  } finally {
    try { adapter.exec("DETACH DATABASE chk"); } catch {}
  }
}

function verifySqlJsBackup(adapter, dest) {
  const copy = new adapter.raw.constructor(fs.readFileSync(dest));
  try {
    const cols = columnsOf(null);
    checkCopy(adapter, backedUpTables(adapter, new Set()), {
      ref: (t) => t,
      columnsSql: (t) => cols(t),
      copyScalar: (sql) =>
        copy.exec(sql === "integrity" ? "PRAGMA integrity_check" : sql)[0]?.values?.[0]?.[0],
    });
  } finally {
    copy.close();
  }
}

/**
 * A backup that must exist before a one-way change: taken, then verified. Throws on any
 * failure so the caller can refuse to go on. Returns the backup directory.
 */
export function requiredBackup(adapter, label) {
  let dir;
  try {
    dir = makeBackupDir(label);
    if (adapter.driver === "sql.js") {
      // In-memory engine: ATTACH can't reach the disk. Write the whole DB, reopen it to verify.
      const dest = path.join(dir, "data.sqlite");
      fs.writeFileSync(dest, Buffer.from(adapter.raw.export()));
      verifySqlJsBackup(adapter, dest);
    } else {
      verifyBackup(adapter, backupDbLite(adapter, dir));
    }
    return dir;
  } catch (e) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    throw new Error(`backup "${label}" failed: ${e.message}`);
  }
}
