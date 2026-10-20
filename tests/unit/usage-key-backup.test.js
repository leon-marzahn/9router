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
const backups = () => (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()).sort() : []);

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
  const file = path.join(backupsDir(), dir, "data.sqlite").replace(/'/g, "''");
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
  try {
    fs.chmodSync(backupsDir(), 0o755);
  } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("pre-usage-key-refs backup", () => {
  it("is taken, verified and pinned before migration 005 rewrites raw keys", async () => {
    await schema4WithRawKey();
    const db = await boot();
    const pinned = backups().filter((d) => d.startsWith("pre-usage-key-refs-"));
    expect(pinned).toHaveLength(1);
    expect(rawRowsInBackup(db, pinned[0])).toBe(1);
    expect(db.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [RAW]).c).toBe(0);
  });

  it("stops the boot when it can't be written, leaving usage untouched", async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only dir
    await schema4WithRawKey();
    fs.mkdirSync(backupsDir(), { recursive: true });
    fs.chmodSync(backupsDir(), 0o555);
    await expect(boot()).rejects.toThrow(
      /Refusing to rewrite usage API keys without a verified backup/,
    );
    fs.chmodSync(backupsDir(), 0o755);
    // Nothing was migrated: the next boot (backup possible again) still sees schema 4 + the raw key.
    const db = await boot();
    const pinned = backups().filter((d) => d.startsWith("pre-usage-key-refs-"));
    expect(pinned).toHaveLength(1);
    expect(rawRowsInBackup(db, pinned[0])).toBe(1);
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("5");
  });

  it("survives pruning, whatever its age", async () => {
    await schema4WithRawKey();
    await boot();
    const { pruneOldBackups } = await import("@/lib/db/backup.js");
    const old = new Date("2000-01-01");
    const pinned = backups().find((d) => d.startsWith("pre-usage-key-refs-"));
    fs.utimesSync(path.join(backupsDir(), pinned), old, old);
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(backupsDir(), `schema-x-${i}`));
    pruneOldBackups();
    const left = backups();
    expect(left).toContain(pinned);
    expect(left.filter((d) => !d.startsWith("pre-usage-key-refs-"))).toHaveLength(3);
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
