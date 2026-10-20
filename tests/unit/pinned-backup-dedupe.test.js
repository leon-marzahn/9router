// One pinned backup per upgrade: a boot that runs migrations 005 and 006 together takes a
// single plaintext copy of the starting DB, named and described (backup.json) by the
// schema it restores to, not by the running app version. Old-style names still count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
const RAW = "sk-dedupe-test-raw-client-key-000000";
const SECRET = "sk-live-FAKE-dedupe-provider-000001";
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../../package.json"), "utf8"),
).version;

async function boot() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._credentialsKeyring;
  vi.resetModules();
  return (await import("@/lib/db/driver.js")).getAdapter();
}

const pinnedDir = () => path.join(tempDir, "db", "pinned-backups");
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const dbPath = () => path.join(tempDir, "db", "data.sqlite");

/** A DB as v100.7.x (schema 4) or v101.0.x (schema 5) left it: raw usage key / plaintext credential. */
async function olderDb(schema) {
  const db = await boot();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c1', 'openai', 'apikey', 'k', 1, 1, ?, ?, ?)`,
    [JSON.stringify({ apiKey: SECRET }), now, now],
  );
  if (schema === 4) {
    db.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, 1, 1, 0, 'ok')",
      [now, RAW],
    );
  }
  db.run("UPDATE _meta SET value = ? WHERE key = 'schemaVersion'", [String(schema)]);
  db.run(
    "DELETE FROM _meta WHERE key IN ('usageKeyRefsMigrated', 'usageKeysScrubbed', 'credentialsKeyId', 'credentialsScrubbed')",
  );
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return db;
}

const readMeta = (dir) => JSON.parse(fs.readFileSync(path.join(pinnedDir(), dir, "backup.json"), "utf8"));

/** Values from a backup's data.sqlite, through the live adapter. */
function inBackup(db, dir) {
  const file = path.join(pinnedDir(), dir, "data.sqlite").replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${file}' AS b`);
  try {
    return {
      schema: db.get("SELECT value FROM b._meta WHERE key = 'schemaVersion'").value,
      rawUsage: db.get("SELECT COUNT(*) AS c FROM b.usageHistory WHERE apiKey = ?", [RAW]).c,
      apiKey: JSON.parse(db.get("SELECT data FROM b.providerConnections WHERE id = 'c1'").data).apiKey,
    };
  } finally {
    db.exec("DETACH DATABASE b");
  }
}

/** Restore drill: stop, move the live DB aside, copy the backup in, boot through the DB layer. */
async function restore(dir) {
  global._dbAdapter.instance.close();
  delete global._dbAdapter;
  for (const f of ["data.sqlite", "data.sqlite-wal", "data.sqlite-shm"])
    fs.rmSync(path.join(tempDir, "db", f), { force: true });
  fs.copyFileSync(path.join(pinnedDir(), dir, "data.sqlite"), dbPath());
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-dedupe-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.CREDENTIALS_KEY;
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._credentialsKeyring;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("pinned backup per upgrade", () => {
  it("v100 → v102 takes exactly one plaintext backup for 005 and 006, labelled schema 4", async () => {
    await olderDb(4);
    const logs = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const db = await boot();
    spy.mockRestore();
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("6");

    const pinned = list(pinnedDir());
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^pre-usage-key-refs\+encrypt-credentials-schema4-\d{8}-\d{6}$/);
    expect(readMeta(pinned[0])).toEqual({
      schemaVersion: 4,
      createdBy: APP_VERSION,
      precedes: ["pre-usage-key-refs", "pre-encrypt-credentials"],
      heal: false,
      restoresTo: "v100.7.x (e.g. v100.7.2)",
    });
    expect(inBackup(db, pinned[0])).toEqual({ schema: "4", rawUsage: 1, apiKey: SECRET });
    expect(logs.join("\n")).toMatch(
      /pinned backup before pre-usage-key-refs \+ pre-encrypt-credentials \(verified, schema 4, restores v100\.7\.x/,
    );
    if (process.platform !== "win32") {
      const dir = path.join(pinnedDir(), pinned[0]);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    }

    // Restore drill: the copy is the v100.7.x DB, and boots through the DB layer.
    await restore(pinned[0]);
    const again = await boot();
    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c1")).apiKey).toBe(SECRET);
    expect(again.get("SELECT COUNT(*) AS c FROM usageHistory").c).toBe(1);
  });

  it("v101 → v102 takes one pre-encrypt-credentials backup labelled for v101", async () => {
    await olderDb(5);
    const db = await boot();
    const pinned = list(pinnedDir());
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^pre-encrypt-credentials-schema5-/);
    expect(readMeta(pinned[0])).toMatchObject({
      schemaVersion: 5,
      createdBy: APP_VERSION,
      precedes: ["pre-encrypt-credentials"],
      restoresTo: "v101.0.x (e.g. v101.0.2)",
    });
    expect(inBackup(db, pinned[0])).toMatchObject({ schema: "5", apiKey: SECRET });

    await restore(pinned[0]);
    await boot();
    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c1")).apiKey).toBe(SECRET);
  });

  it("aborts the boot, untouched, when the shared backup can't be taken", async () => {
    if (process.platform === "win32") return;
    await olderDb(4);
    fs.mkdirSync(pinnedDir(), { recursive: true });
    fs.chmodSync(pinnedDir(), 0o555);
    try {
      await expect(boot()).rejects.toThrow(
        /backup "pre-usage-key-refs\+encrypt-credentials" failed: .*Refusing to rewrite usage API keys \(005\) and encrypt stored credentials \(006\) without a verified backup; nothing was changed\. Fix permissions or disk space on DATA_DIR\/db \(incl\. db\/pinned-backups\) and restart\./,
      );
    } finally {
      fs.chmodSync(pinnedDir(), 0o755);
    }
    expect(list(pinnedDir())).toEqual([]);
  });

  it("names a rekey pass pending with 005 correctly in the abort message", async () => {
    if (process.platform === "win32") return;
    const { randomBytes } = await import("node:crypto");
    const KEY_A = randomBytes(32).toString("hex");
    const KEY_B = randomBytes(32).toString("hex");
    process.env.CREDENTIALS_KEY = KEY_A;
    await olderDb(5);
    let db = await boot(); // encrypted under KEY_A, schema 6
    db.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, 1, 1, 0, 'ok')",
      [new Date().toISOString(), RAW],
    );
    db.run("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");
    db.run("DELETE FROM _meta WHERE key IN ('usageKeyRefsMigrated', 'usageKeysScrubbed')");
    process.env.CREDENTIALS_KEY = KEY_B;
    process.env.CREDENTIALS_KEY_PREVIOUS = KEY_A;
    fs.chmodSync(pinnedDir(), 0o555);
    try {
      await expect(boot()).rejects.toThrow(
        /backup "pre-usage-key-refs\+credentials-rekey" failed: .*Refusing to rewrite usage API keys \(005\) and re-encrypt stored credentials under the new key without/,
      );
    } finally {
      fs.chmodSync(pinnedDir(), 0o755);
      delete process.env.CREDENTIALS_KEY;
      delete process.env.CREDENTIALS_KEY_PREVIOUS;
    }
  });
});

describe("release lines and metadata", () => {
  it("has a release line for every schema up to the latest migration", async () => {
    const { RELEASE_LINES } = await import("@/lib/db/pinnedBackups.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const highest = Math.max(...Object.keys(RELEASE_LINES).map(Number));
    expect(highest).toBeGreaterThanOrEqual(latestVersion());
    expect(RELEASE_LINES[6]).toMatch(/^v102\./);
  });

  it("marks heal backups from the step, not the schema number", async () => {
    const { backupMeta, describeBackup } = await import("@/lib/db/pinnedBackups.js");
    const heal = backupMeta({ labels: "pre-usage-key-heal", schemaVersion: 6, appVersion: "102.0.0" });
    expect(heal).toMatchObject({ heal: true, restoresTo: expect.stringMatching(/^v102\.x .*after a downgrade/) });
    expect(backupMeta({ labels: "pre-usage-key-scrub", schemaVersion: 6 }).heal).toBe(true);
    expect(backupMeta({ labels: "pre-encrypt-credentials", schemaVersion: 6, heal: true }).heal).toBe(true);
    // A straight upgrade from a future schema 6 is not a downgrade.
    const upgrade = backupMeta({ labels: "pre-encrypt-credentials", schemaVersion: 6 });
    expect(upgrade).toMatchObject({ heal: false, restoresTo: "v102.x (e.g. v102.0.0)" });
    expect(describeBackup("/x/pre-usage-key-heal-schema6-1").heal).toBe(true);
  });

  it("writes createdBy: null when the app version is unknown", async () => {
    const { backupMeta } = await import("@/lib/db/pinnedBackups.js");
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4, appVersion: "0.0.0" }).createdBy).toBeNull();
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4 }).createdBy).toBeNull();
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4, appVersion: "102.0.0" }).createdBy).toBe("102.0.0");
  });

  it("the heal's encrypt backup at boot is flagged heal in backup.json", async () => {
    await olderDb(5);
    let db = await boot();
    // An older version writes a plaintext credential after a downgrade.
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c9', 'openai', 'apikey', 'k', 1, 1, ?, ?, ?)`,
      [JSON.stringify({ apiKey: SECRET }), now, now],
    );
    db = await boot();
    const heal = list(pinnedDir()).filter((d) => readMeta(d).heal);
    expect(heal).toHaveLength(1);
    expect(heal[0]).toMatch(/^pre-encrypt-credentials-schema6-/);
    expect(readMeta(heal[0]).restoresTo).toMatch(/^v102\.x .*after a downgrade/);
  });
});

describe("names", () => {
  it("parses new and old-style names, pinning only the restore points", async () => {
    const { parseBackupName, isPinnedName, describeBackup } = await import("@/lib/db/pinnedBackups.js");
    expect(parseBackupName("pre-usage-key-refs+encrypt-credentials-schema4-20261020-101500")).toEqual({
      labels: ["pre-usage-key-refs", "pre-encrypt-credentials"],
      schemaVersion: 4,
    });
    expect(isPinnedName("pre-usage-key-refs-100.7.2-20260101-000000")).toBe(true);
    expect(isPinnedName("pre-encrypt-credentials-101.0.2-20260101-000000")).toBe(true);
    expect(isPinnedName("pre-usage-key-heal-schema6-20260101-000000")).toBe(false);
    expect(isPinnedName("schema-3-to-4-100.0.0-x")).toBe(false);
    expect(describeBackup("/x/pre-encrypt-credentials-102.0.0-20260101-000000")).toMatchObject({
      schemaVersion: 5,
      createdBy: "102.0.0",
      precedes: ["pre-encrypt-credentials"],
    });
    expect(describeBackup("/x/unknown").restoresTo).toMatch(/unknown release/);
    expect(describeBackup("/x/pre-x-schema99-1").restoresTo).toMatch(/unknown release \(schema 99\)/);
  });

  it("purge-plaintext-backups lists old-style and new backups with their schema and release", async () => {
    await olderDb(4);
    await boot();
    const old = [
      path.join(pinnedDir(), "pre-usage-key-refs-101.0.2-20260101-000000"),
      path.join(pinnedDir(), "pre-encrypt-credentials-102.0.0-20260101-000000"),
    ];
    for (const d of old) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "data.sqlite"), "x");
    }
    const stray = path.join(pinnedDir(), "notes-not-a-backup");
    fs.mkdirSync(stray);
    const script = path.join(import.meta.dirname, "../../scripts/purge-plaintext-backups.mjs");
    const env = { ...process.env, DATA_DIR: tempDir };
    const out = execFileSync(process.execPath, [script], { env }).toString();
    for (const d of old) expect(out).toContain(d);
    expect(out).toMatch(
      /pre-usage-key-refs\+encrypt-credentials-schema4-\S+\n {4}restore point for v100\.7\.x \(e\.g\. v100\.7\.2\)\n {4}DB schema 4, taken before usage key references \(migration 005\) and credential encryption \(migration 006\) by v/,
    );
    expect(out).toMatch(/pre-usage-key-refs-101\.0\.2-\S+\n {4}restore point for v100\.7\.x.*\n {4}DB schema 4, .* by v101\.0\.2/);
    expect(out).toMatch(/pre-encrypt-credentials-102\.0\.0-\S+\n {4}restore point for v101\.0\.x/);
    expect(out).toMatch(/Not a recognised backup, left untouched.*\n {2}\S*notes-not-a-backup/);
    expect(out).not.toMatch(/notes-not-a-backup\n {4}restore point/);
    execFileSync(process.execPath, [script, "--yes"], { env });
    expect(list(pinnedDir())).toEqual(["notes-not-a-backup"]);
  });

  it("names a rekey pass pending with 005 correctly in the abort message", async () => {
    if (process.platform === "win32") return;
    const { randomBytes } = await import("node:crypto");
    const KEY_A = randomBytes(32).toString("hex");
    const KEY_B = randomBytes(32).toString("hex");
    process.env.CREDENTIALS_KEY = KEY_A;
    await olderDb(5);
    let db = await boot(); // encrypted under KEY_A, schema 6
    db.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, 1, 1, 0, 'ok')",
      [new Date().toISOString(), RAW],
    );
    db.run("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");
    db.run("DELETE FROM _meta WHERE key IN ('usageKeyRefsMigrated', 'usageKeysScrubbed')");
    process.env.CREDENTIALS_KEY = KEY_B;
    process.env.CREDENTIALS_KEY_PREVIOUS = KEY_A;
    fs.chmodSync(pinnedDir(), 0o555);
    try {
      await expect(boot()).rejects.toThrow(
        /backup "pre-usage-key-refs\+credentials-rekey" failed: .*Refusing to rewrite usage API keys \(005\) and re-encrypt stored credentials under the new key without/,
      );
    } finally {
      fs.chmodSync(pinnedDir(), 0o755);
      delete process.env.CREDENTIALS_KEY;
      delete process.env.CREDENTIALS_KEY_PREVIOUS;
    }
  });
});

describe("release lines and metadata", () => {
  it("has a release line for every schema up to the latest migration", async () => {
    const { RELEASE_LINES } = await import("@/lib/db/pinnedBackups.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const highest = Math.max(...Object.keys(RELEASE_LINES).map(Number));
    expect(highest).toBeGreaterThanOrEqual(latestVersion());
    expect(RELEASE_LINES[6]).toMatch(/^v102\./);
  });

  it("marks heal backups from the step, not the schema number", async () => {
    const { backupMeta, describeBackup } = await import("@/lib/db/pinnedBackups.js");
    const heal = backupMeta({ labels: "pre-usage-key-heal", schemaVersion: 6, appVersion: "102.0.0" });
    expect(heal).toMatchObject({ heal: true, restoresTo: expect.stringMatching(/^v102\.x .*after a downgrade/) });
    expect(backupMeta({ labels: "pre-usage-key-scrub", schemaVersion: 6 }).heal).toBe(true);
    expect(backupMeta({ labels: "pre-encrypt-credentials", schemaVersion: 6, heal: true }).heal).toBe(true);
    // A straight upgrade from a future schema 6 is not a downgrade.
    const upgrade = backupMeta({ labels: "pre-encrypt-credentials", schemaVersion: 6 });
    expect(upgrade).toMatchObject({ heal: false, restoresTo: "v102.x (e.g. v102.0.0)" });
    expect(describeBackup("/x/pre-usage-key-heal-schema6-1").heal).toBe(true);
  });

  it("writes createdBy: null when the app version is unknown", async () => {
    const { backupMeta } = await import("@/lib/db/pinnedBackups.js");
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4, appVersion: "0.0.0" }).createdBy).toBeNull();
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4 }).createdBy).toBeNull();
    expect(backupMeta({ labels: "pre-usage-key-refs", schemaVersion: 4, appVersion: "102.0.0" }).createdBy).toBe("102.0.0");
  });

  it("the heal's encrypt backup at boot is flagged heal in backup.json", async () => {
    await olderDb(5);
    let db = await boot();
    // An older version writes a plaintext credential after a downgrade.
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c9', 'openai', 'apikey', 'k', 1, 1, ?, ?, ?)`,
      [JSON.stringify({ apiKey: SECRET }), now, now],
    );
    db = await boot();
    const heal = list(pinnedDir()).filter((d) => readMeta(d).heal);
    expect(heal).toHaveLength(1);
    expect(heal[0]).toMatch(/^pre-encrypt-credentials-schema6-/);
    expect(readMeta(heal[0]).restoresTo).toMatch(/^v102\.x .*after a downgrade/);
  });
});
