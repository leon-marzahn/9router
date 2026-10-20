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
      await expect(boot()).rejects.toThrow(/pre-usage-key-refs\+pre-encrypt-credentials" failed/);
    } finally {
      fs.chmodSync(pinnedDir(), 0o755);
    }
    expect(list(pinnedDir())).toEqual([]);
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
    expect(describeBackup("/x/unknown").restoresTo).toMatch(/older version/);
    expect(describeBackup("/x/pre-x-schema7-1").restoresTo).toMatch(/after a downgrade/);
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
    const script = path.join(import.meta.dirname, "../../scripts/purge-plaintext-backups.mjs");
    const env = { ...process.env, DATA_DIR: tempDir };
    const out = execFileSync(process.execPath, [script], { env }).toString();
    for (const d of old) expect(out).toContain(d);
    expect(out).toMatch(
      /pre-usage-key-refs\+encrypt-credentials-schema4-\S+\n {4}restore point for v100\.7\.x \(e\.g\. v100\.7\.2\)\n {4}DB schema 4, taken before usage key references \(migration 005\) and credential encryption \(migration 006\) by v/,
    );
    expect(out).toMatch(/pre-usage-key-refs-101\.0\.2-\S+\n {4}restore point for v100\.7\.x.*\n {4}DB schema 4, .* by v101\.0\.2/);
    expect(out).toMatch(/pre-encrypt-credentials-102\.0\.0-\S+\n {4}restore point for v101\.0\.x/);
    execFileSync(process.execPath, [script, "--yes"], { env });
    expect(list(pinnedDir())).toEqual([]);
  });
});
