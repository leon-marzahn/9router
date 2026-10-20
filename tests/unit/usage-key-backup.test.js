// Backups around the one-way usage key rewrite (migration 005, the boot heal, the scrub):
// required and verified, the boot stops when one can't be taken, and the
// pre-usage-key-refs backup is pinned against pruning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
const RAW = "sk-backup-test-raw-key-0000000000";

async function boot() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  vi.resetModules();
  return (await import("@/lib/db/driver.js")).getAdapter();
}

const backupsDir = () => path.join(tempDir, "db", "backups");
const pinnedDir = () => path.join(tempDir, "db", "pinned-backups");
const isPinnedName = (d) => d.startsWith("pre-usage-key-refs-");
const dirOf = (d) => path.join(isPinnedName(d) ? pinnedDir() : backupsDir(), d);
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const backups = () => [...list(backupsDir()), ...list(pinnedDir())].sort();

/** A DB as the previous release left it: schema 4, a raw key in usage. */
async function schema4WithRawKey() {
  const db = await boot();
  db.run(
    "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, 1, 1, 0, 'ok')",
    [new Date().toISOString(), RAW],
  );
  db.run("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");
  db.run("DELETE FROM _meta WHERE key IN ('usageKeyRefsMigrated', 'usageKeysScrubbed')");
  return db;
}

/** Count rows with the raw key in a backup's data.sqlite, through the live adapter. */
function rawRowsInBackup(db, dir) {
  const file = path.join(dirOf(dir), "data.sqlite").replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${file}' AS b`);
  try {
    return db.get("SELECT COUNT(*) AS c FROM b.usageHistory WHERE apiKey = ?", [RAW]).c;
  } finally {
    db.exec("DETACH DATABASE b");
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-keybackup-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  for (const d of [backupsDir(), pinnedDir()]) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {}
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("pre-usage-key-refs backup", () => {
  it("is taken, verified and pinned before migration 005 rewrites raw keys", async () => {
    await schema4WithRawKey();
    const db = await boot();
    const pinned = backups().filter(isPinnedName);
    expect(pinned).toHaveLength(1);
    expect(rawRowsInBackup(db, pinned[0])).toBe(1);
    expect(db.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [RAW]).c).toBe(0);
  });

  it("stops the boot when it can't be written, leaving usage untouched", async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only dir
    await schema4WithRawKey();
    fs.mkdirSync(pinnedDir(), { recursive: true });
    fs.chmodSync(pinnedDir(), 0o555);
    await expect(boot()).rejects.toThrow(
      /Refusing to rewrite usage API keys without a verified backup/,
    );
    fs.chmodSync(pinnedDir(), 0o755);
    // Nothing was migrated: the next boot (backup possible again) still sees schema 4 + the raw key.
    const db = await boot();
    const pinned = backups().filter(isPinnedName);
    expect(pinned).toHaveLength(1);
    expect(rawRowsInBackup(db, pinned[0])).toBe(1);
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("6");
  });

  it("lives outside db/backups and survives pruning, ours and an older release's", async () => {
    await schema4WithRawKey();
    await boot();
    const pinned = backups().find(isPinnedName);
    expect(fs.existsSync(path.join(pinnedDir(), pinned))).toBe(true);
    expect(list(backupsDir()).some(isPinnedName)).toBe(false);
    const old = new Date("2000-01-01");
    fs.utimesSync(path.join(pinnedDir(), pinned), old, old);
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(backupsDir(), `schema-x-${i}`));

    // master's pruner (before this change): every folder in db/backups, newest 3 kept.
    const masterPrune = () => {
      const entries = fs
        .readdirSync(backupsDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({
          full: path.join(backupsDir(), e.name),
          mtime: fs.statSync(path.join(backupsDir(), e.name)).mtimeMs,
        }))
        .sort((x, y) => y.mtime - x.mtime);
      for (const e of entries.slice(3)) fs.rmSync(e.full, { recursive: true, force: true });
    };
    for (let i = 0; i < 4; i++) masterPrune(); // several boots of a downgraded build
    const { pruneOldBackups } = await import("@/lib/db/backup.js");
    pruneOldBackups();
    expect(backups()).toContain(pinned);
    expect(list(backupsDir())).toHaveLength(3);
  });
});

describe("backup verification", () => {
  it("rejects a copy whose rows, columns or usage aggregates differ", async () => {
    await schema4WithRawKey();
    const db = await boot();
    const { backupDbLite, verifyBackup } = await import("@/lib/db/backup.js");
    const dir = path.join(tempDir, "check");
    fs.mkdirSync(dir);
    const dest = backupDbLite(db, dir);
    expect(() => verifyBackup(db, dest)).not.toThrow();
    const tamper = (sql) => {
      db.exec(`ATTACH DATABASE '${dest}' AS t`);
      try {
        db.exec(sql);
      } finally {
        db.exec("DETACH DATABASE t");
      }
    };
    tamper("UPDATE t.usageHistory SET cost = cost + 1");
    expect(() => verifyBackup(db, dest)).toThrow(/usageHistory cost/);
    tamper("UPDATE t.usageHistory SET cost = cost - 1");
    tamper("UPDATE t.usageHistory SET apiKey = 'other'");
    expect(() => verifyBackup(db, dest)).not.toThrow(); // same count of distinct keys
    tamper(
      "INSERT INTO t.usageHistory(timestamp, apiKey) SELECT timestamp, 'x' FROM t.usageHistory",
    );
    expect(() => verifyBackup(db, dest)).toThrow(/usageHistory rows/);
    tamper("DELETE FROM t.usageHistory WHERE apiKey = 'x'");
    tamper("ALTER TABLE t.apiKeys ADD COLUMN extra TEXT");
    expect(() => verifyBackup(db, dest)).toThrow(/apiKeys columns/);
    fs.writeFileSync(dest, "");
    expect(() => verifyBackup(db, dest)).toThrow(/missing/);
  });

  it("works on the sql.js fallback driver (full export, reopened to verify)", async () => {
    vi.resetModules(); // paths.js reads DATA_DIR at import
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { requiredBackup } = await import("@/lib/db/backup.js");
    const a = await createSqlJsAdapter(path.join(tempDir, "sqljs.sqlite"));
    a.exec("CREATE TABLE usageHistory(id INTEGER PRIMARY KEY, apiKey TEXT, cost REAL)");
    a.exec("CREATE TABLE usageDaily(dateKey TEXT PRIMARY KEY, data TEXT)");
    a.run("INSERT INTO usageHistory(apiKey, cost) VALUES(?, 1.5)", [RAW]);
    a.run("INSERT INTO usageDaily(dateKey, data) VALUES('2026-01-01', '{}')");
    const dir = requiredBackup(a, "pre-usage-key-refs");
    expect(dir.startsWith(pinnedDir())).toBe(true);
    const copy = await createSqlJsAdapter(path.join(dir, "data.sqlite"));
    expect(copy.get("SELECT apiKey, cost FROM usageHistory")).toEqual({ apiKey: RAW, cost: 1.5 });
    copy.close();
    a.close();
  });

  it("fails with the label when the copy can't be written", async () => {
    if (process.getuid?.() === 0) return;
    vi.resetModules(); // paths.js reads DATA_DIR at import
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { requiredBackup } = await import("@/lib/db/backup.js");
    const a = await createSqlJsAdapter(path.join(tempDir, "sqljs2.sqlite"));
    fs.mkdirSync(backupsDir(), { recursive: true });
    fs.chmodSync(backupsDir(), 0o555);
    expect(() => requiredBackup(a, "pre-usage-key-heal")).toThrow(
      /backup "pre-usage-key-heal" failed/,
    );
    a.close();
  });
});

describe("boot heal", () => {
  async function migratedThenDowngradedWrite() {
    await schema4WithRawKey();
    const db = await boot(); // migrates
    db.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, 1, 1, 0, 'ok')",
      [new Date().toISOString(), RAW],
    );
  }

  it("takes its own verified backup before rewriting, then rewrites and vacuums", async () => {
    await migratedThenDowngradedWrite();
    const db = await boot();
    const heal = backups().filter((d) => d.startsWith("pre-usage-key-heal-"));
    expect(heal).toHaveLength(1);
    expect(rawRowsInBackup(db, heal[0])).toBe(1);
    expect(db.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [RAW]).c).toBe(0);
    expect(db.get("SELECT value FROM _meta WHERE key = 'usageKeysScrubbed'").value).toBe("1");
  });

  it("stops the boot when its backup fails, leaving the raw rows for the next try", async () => {
    if (process.getuid?.() === 0) return;
    await migratedThenDowngradedWrite();
    fs.chmodSync(backupsDir(), 0o555);
    await expect(boot()).rejects.toThrow(/pre-usage-key-heal/);
    fs.chmodSync(backupsDir(), 0o755);
    const db = await boot();
    expect(db.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [RAW]).c).toBe(0);
  });

  it("a pending scrub alone also needs a backup first", async () => {
    if (process.getuid?.() === 0) return;
    await schema4WithRawKey();
    const db = await boot();
    db.run("UPDATE _meta SET value = '0' WHERE key = 'usageKeysScrubbed'"); // crashed before VACUUM
    fs.chmodSync(backupsDir(), 0o555);
    await expect(boot()).rejects.toThrow(/pre-usage-key-scrub/);
    fs.chmodSync(backupsDir(), 0o755);
    const db2 = await boot();
    expect(backups().some((d) => d.startsWith("pre-usage-key-scrub-"))).toBe(true);
    expect(db2.get("SELECT value FROM _meta WHERE key = 'usageKeysScrubbed'").value).toBe("1");
  });
});
