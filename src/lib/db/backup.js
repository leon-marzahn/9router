// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically,
//   except pinned ones (PINNED_BACKUP_LABELS), which are never pruned.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

const KEEP_BACKUPS = 3;

// Backups that must survive pruning: the last copy of data before a one-way migration.
export const PRE_USAGE_KEY_REFS = "pre-usage-key-refs";
const PINNED_BACKUP_LABELS = [PRE_USAGE_KEY_REFS];
const isPinned = (name) => PINNED_BACKUP_LABELS.some((l) => name.startsWith(`${l}-`));

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
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
 * Every table the backup copied must open and hold the same row count as the live DB.
 * Throws when it doesn't. Run right after backupDbLite, before anything writes.
 */
export function verifyBackup(adapter, dest) {
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error(`backup file missing: ${dest}`);
  const escaped = dest.replace(/'/g, "''");
  adapter.exec(`ATTACH DATABASE '${escaped}' AS chk`);
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = adapter
      .all(`SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .filter((t) => !excluded.has(t.name));
    for (const { name } of tables) {
      const live = adapter.get(`SELECT COUNT(*) AS c FROM main.${name}`)?.c;
      const copy = adapter.get(`SELECT COUNT(*) AS c FROM chk.${name}`)?.c;
      if (live !== copy) throw new Error(`backup ${name}: ${copy} rows, live DB has ${live}`);
    }
  } finally {
    try { adapter.exec("DETACH DATABASE chk"); } catch {}
  }
}

function verifySqlJsBackup(adapter, dest) {
  const copy = new adapter.raw.constructor(fs.readFileSync(dest));
  try {
    const tables = adapter.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    for (const { name } of tables) {
      const live = adapter.get(`SELECT COUNT(*) AS c FROM ${name}`)?.c;
      const got = copy.exec(`SELECT COUNT(*) FROM ${name}`)[0]?.values?.[0]?.[0];
      if (live !== got) throw new Error(`backup ${name}: ${got} rows, live DB has ${live}`);
    }
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
