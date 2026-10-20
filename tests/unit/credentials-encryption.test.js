// Provider credentials at rest: the AES-256-GCM envelope, the key (env / generated file,
// fail closed), migration 006 with its required pinned backup, the downgrade heal, the
// VACUUM, key rotation, and every repo's read/write path.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
const SECRETS = {
  apiKey: "sk-live-FAKE-apikey-000000000001",
  accessToken: "ya29.FAKE-access-token-0000000002",
  refreshToken: "1//FAKE-refresh-token-000000003",
  sessionToken: "FAKE-session-token-00000000004",
  proxyPass: "FAKE-proxy-pass-0000000005",
  smtp: "FAKE-smtp-password-000000006",
  oidc: "FAKE-oidc-client-secret-0000007",
};
const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("hex");

async function boot() {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._credentialsKeyring;
  vi.resetModules();
  return (await import("@/lib/db/driver.js")).getAdapter();
}

const keyFile = () => path.join(tempDir, "credentials.key");
const pinnedDir = () => path.join(tempDir, "db", "pinned-backups");
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const dbFiles = () =>
  list(path.join(tempDir, "db"))
    .filter((f) => f.startsWith("data.sqlite"))
    .map((f) => path.join(tempDir, "db", f));
const plaintextHits = () =>
  dbFiles().reduce(
    (n, f) => n + Object.values(SECRETS).filter((s) => fs.readFileSync(f).includes(s)).length,
    0,
  );

/** A DB as master (schema 5) left it: plaintext credentials in all three tables. */
async function schema5WithPlaintext() {
  const db = await boot();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c1', 'openai', 'apikey', 'k', 1, 1, ?, ?, ?)`,
    [JSON.stringify({ apiKey: SECRETS.apiKey, testStatus: "active" }), now, now],
  );
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c2', 'gemini-cli', 'oauth', 'o', 1, 1, ?, ?, ?)`,
    [
      JSON.stringify({
        accessToken: SECRETS.accessToken,
        refreshToken: SECRETS.refreshToken,
        expiresAt: "2030-01-01T00:00:00Z",
        providerSpecificData: { sessionToken: SECRETS.sessionToken, region: "eu" },
      }),
      now,
      now,
    ],
  );
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES('p1', 1, 'ok', ?, ?, ?)`,
    [
      JSON.stringify({ name: "pool", proxyUrl: `http://u:${SECRETS.proxyPass}@proxy.test:8080` }),
      now,
      now,
    ],
  );
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [
      JSON.stringify({
        notifySmtpPassword: SECRETS.smtp,
        oidcClientSecret: SECRETS.oidc,
        requireApiKey: true,
      }),
    ],
  );
  db.run("UPDATE _meta SET value = '5' WHERE key = 'schemaVersion'");
  db.run("DELETE FROM _meta WHERE key IN ('credentialsKeyId', 'credentialsScrubbed')");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return db;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-creds-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.CREDENTIALS_KEY;
  delete process.env.CREDENTIALS_KEY_PREVIOUS;
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._credentialsKeyring;
  delete process.env.CREDENTIALS_KEY;
  delete process.env.CREDENTIALS_KEY_PREVIOUS;
  try {
    fs.chmodSync(pinnedDir(), 0o755);
  } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("envelope", () => {
  async function ringOf(text) {
    vi.resetModules();
    const k = await import("@/lib/credentials/keyring.js");
    const key = k.parseKey(text, "test");
    return { current: key, currentId: k.keyIdOf(key), keys: new Map([[k.keyIdOf(key), key]]) };
  }
  const ctx = { table: "providerConnections", column: "data", id: "c1", path: "apiKey" };

  it("round-trips with a fresh IV each time and a versioned format", async () => {
    const { encryptValue, decryptValue } = await import("@/lib/credentials/envelope.js");
    const ring = await ringOf(KEY_A);
    const a = encryptValue("secret-value", ctx, ring);
    const b = encryptValue("secret-value", ctx, ring);
    expect(a).toMatch(/^enc:v1:[\w-]+:[\w-]{16}:[\w-]{22}:[\w-]*$/);
    expect(a).not.toBe(b);
    expect(decryptValue(a, ctx, ring)).toBe("secret-value");
    expect(decryptValue(encryptValue("", ctx, ring), ctx, ring)).toBe("");
  });

  it("detects a tampered tag or ciphertext", async () => {
    const { encryptValue, decryptValue } = await import("@/lib/credentials/envelope.js");
    const ring = await ringOf(KEY_A);
    const env = encryptValue("secret-value", ctx, ring);
    const parts = env.split(":");
    const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const badTag = [...parts.slice(0, 4), flip(parts[4]), parts[5]].join(":");
    const badCt = [...parts.slice(0, 5), flip(parts[5])].join(":");
    expect(() => decryptValue(badTag, ctx, ring)).toThrow(/failed authentication/);
    expect(() => decryptValue(badCt, ctx, ring)).toThrow(/failed authentication/);
  });

  it("binds the value to table, column, row id and field (AAD)", async () => {
    const { encryptValue, decryptValue } = await import("@/lib/credentials/envelope.js");
    const ring = await ringOf(KEY_A);
    const env = encryptValue("secret-value", ctx, ring);
    for (const moved of [
      { id: "c2" },
      { path: "refreshToken" },
      { table: "proxyPools" },
      { column: "other" },
    ]) {
      expect(() => decryptValue(env, { ...ctx, ...moved }, ring)).toThrow(/failed authentication/);
    }
  });

  it("refuses a wrong key and a missing key", async () => {
    const { encryptValue, decryptValue } = await import("@/lib/credentials/envelope.js");
    const a = await ringOf(KEY_A);
    const b = await ringOf(KEY_B);
    const env = encryptValue("secret-value", ctx, a);
    expect(() => decryptValue(env, ctx, b)).toThrow(/No credentials key with id/);
    // Same key id but other key bytes (a forged id) still fails authentication.
    expect(() =>
      decryptValue(env, ctx, { ...b, keys: new Map([[a.currentId, b.current]]) }),
    ).toThrow(/failed authentication/);
    vi.resetModules();
    delete global._credentialsKeyring;
    const k = await import("@/lib/credentials/keyring.js");
    expect(() => k.getKeyring()).toThrow(k.CredentialsKeyError);
  });

  it("parses hex and base64 keys and rejects anything else", async () => {
    const k = await import("@/lib/credentials/keyring.js");
    expect(k.parseKey(KEY_A, "t")).toHaveLength(32);
    expect(k.parseKey(KEY_B, "t")).toHaveLength(32);
    expect(k.parseKey(Buffer.from(KEY_B, "hex").toString("base64url"), "t")).toHaveLength(32);
    for (const bad of [
      "",
      "short",
      crypto.randomBytes(16).toString("hex"),
      crypto.randomBytes(24).toString("base64"),
    ]) {
      expect(() => k.parseKey(bad, "t")).toThrow(k.CredentialsKeyError);
    }
  });
});

describe("field coverage", () => {
  const where = { table: "settings", column: "data", id: "1" };
  async function ring() {
    vi.resetModules();
    const k = await import("@/lib/credentials/keyring.js");
    const key = k.parseKey(KEY_A, "t");
    return { current: key, currentId: k.keyIdOf(key), keys: new Map([[k.keyIdOf(key), key]]) };
  }

  it("seals arrays under secret-named keys and credential header maps, and round-trips them", async () => {
    const r = await ring();
    const { sealSecrets, openSecrets, inspectSecrets } =
      await import("@/lib/credentials/fields.js");
    const input = {
      apiKeys: ["k-one-FAKE-00001", { key: "k-two-FAKE-00002", label: "two" }],
      providerOverrides: {
        openai: {
          headers: {
            Authorization: "Bearer FAKE-hdr-1",
            "X-Api-Key": "FAKE-hdr-2",
            "x-goog-api-key": "FAKE-hdr-3",
            "api-key": "FAKE-hdr-4",
            "Proxy-Authorization": "Basic FAKE-hdr-5",
            "X-Trace": "keep-me",
          },
        },
      },
      requestPipelines: [{ steps: [{ headers: { authorization: "Bearer FAKE-hdr-6" } }] }],
      tokens: 5,
      name: "plain",
    };
    const sealed = sealSecrets(input, where, r);
    const json = JSON.stringify(sealed);
    for (const s of ["k-one-FAKE", "k-two-FAKE", "FAKE-hdr-"]) expect(json).not.toContain(s);
    expect(json).toContain("keep-me");
    expect(json).toContain('"label":"enc:v1:'); // everything under a secret-named key
    expect(inspectSecrets(sealed).plaintext).toBe(0);
    expect(inspectSecrets(input).plaintext).toBe(9);
    expect(openSecrets(sealed, where, r)).toEqual(input);
  });

  it("treats only well-formed envelopes as encrypted: a secret that starts with enc: is sealed", async () => {
    const r = await ring();
    const { sealSecrets, openSecrets } = await import("@/lib/credentials/fields.js");
    const { isEnvelope } = await import("@/lib/credentials/envelope.js");
    const odd = { apiKey: "enc:v1:my-real-password" };
    expect(isEnvelope(odd.apiKey)).toBe(false);
    const sealed = sealSecrets(odd, where, r);
    expect(sealed.apiKey).not.toBe(odd.apiKey);
    expect(isEnvelope(sealed.apiKey)).toBe(true);
    expect(openSecrets(sealed, where, r)).toEqual(odd);
  });
});

describe("credentials key", () => {
  it("rejects weak keys", async () => {
    const k = await import("@/lib/credentials/keyring.js");
    expect(() => k.parseKey("00".repeat(32), "t")).toThrow(/weak key/);
    expect(() => k.parseKey("0102".repeat(16), "t")).toThrow(/weak key/);
    expect(() => k.parseKey(Buffer.alloc(32, 7).toString("base64"), "t")).toThrow(/weak key/);
  });

  it("uses the winner's key when another process creates the file first (EEXIST)", async () => {
    vi.resetModules();
    delete global._credentialsKeyring;
    const k = await import("@/lib/credentials/keyring.js");
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, opts) => {
      if (file === k.KEY_FILE) {
        real(file, `${KEY_A}\n`, { mode: 0o600 });
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return real(file, data, opts);
    });
    try {
      const ring = k.ensureCredentialsKey(new Set());
      expect(ring.currentId).toBe(k.keyIdOf(k.parseKey(KEY_A, "t")));
    } finally {
      spy.mockRestore();
    }
  });

  it("is generated on first boot as a 0600 file outside the DB", async () => {
    await boot();
    expect(fs.existsSync(keyFile())).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    const key = fs.readFileSync(keyFile(), "utf8").trim();
    expect(fs.readFileSync(dbFiles()[0]).includes(key)).toBe(false);
  });

  it("uses CREDENTIALS_KEY when set and writes no file", async () => {
    process.env.CREDENTIALS_KEY = KEY_A;
    const db = await boot();
    expect(fs.existsSync(keyFile())).toBe(false);
    const { createProviderConnection } = await import("@/lib/db/index.js");
    await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "x",
      apiKey: SECRETS.apiKey,
    });
    const { keyIdOf, parseKey } = await import("@/lib/credentials/keyring.js");
    const row = db.get("SELECT data FROM providerConnections");
    expect(JSON.parse(row.data).apiKey.split(":")[2]).toBe(keyIdOf(parseKey(KEY_A, "t")));
  });

  it("fails closed when the DB is encrypted and the key is missing: no new key, nothing changed", async () => {
    await schema5WithPlaintext();
    await boot();
    fs.rmSync(keyFile());
    global._dbAdapter.instance.close();
    const before = fs.readFileSync(path.join(tempDir, "db", "data.sqlite"));
    await expect(boot()).rejects.toThrow(/holds encrypted credentials but no key was found/);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, "db", "data.sqlite")).equals(before)).toBe(true);
  });

  it("fails closed with a wrong key", async () => {
    await schema5WithPlaintext();
    await boot();
    process.env.CREDENTIALS_KEY = KEY_B;
    await expect(boot()).rejects.toThrow(/Wrong credentials key/);
  });

  it("still fails closed when only the _meta key id says the DB is encrypted", async () => {
    const db = await boot();
    db.run("INSERT INTO _meta(key, value) VALUES('credentialsKeyId', 'someOtherKey')");
    fs.rmSync(keyFile());
    await expect(boot()).rejects.toThrow(/no key was found/);
  });
});

describe("migration 006", () => {
  it("encrypts every stored credential after a pinned, verified plaintext backup, then vacuums", async () => {
    await schema5WithPlaintext();
    expect(plaintextHits()).toBe(Object.keys(SECRETS).length);
    const db = await boot();

    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("6");
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsScrubbed'").value).toBe("1");
    const conn = JSON.parse(db.get("SELECT data FROM providerConnections WHERE id = 'c2'").data);
    expect(conn.accessToken).toMatch(/^enc:v1:/);
    expect(conn.refreshToken).toMatch(/^enc:v1:/);
    expect(conn.providerSpecificData.sessionToken).toMatch(/^enc:v1:/);
    expect(conn.providerSpecificData.region).toBe("eu");
    expect(conn.expiresAt).toBe("2030-01-01T00:00:00Z");
    const settings = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    expect(settings.requireApiKey).toBe(true);
    expect(settings.notifySmtpPassword).toMatch(/^enc:v1:/);

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(plaintextHits()).toBe(0);

    const pinned = list(pinnedDir()).filter((d) => d.startsWith("pre-encrypt-credentials-"));
    expect(pinned).toHaveLength(1);
    const bak = fs.readFileSync(path.join(pinnedDir(), pinned[0], "data.sqlite"));
    expect(bak.includes(SECRETS.refreshToken)).toBe(true);

    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c2")).refreshToken).toBe(SECRETS.refreshToken);
    expect((await repo.getProxyPoolById("p1")).proxyUrl).toContain(SECRETS.proxyPass);
    expect((await repo.getSettings()).oidcClientSecret).toBe(SECRETS.oidc);
  });

  it("is idempotent: a second boot rewrites nothing and takes no backup", async () => {
    await schema5WithPlaintext();
    let db = await boot();
    const dump = () =>
      db
        .all("SELECT id, data FROM providerConnections ORDER BY id")
        .map((r) => r.data)
        .join("|");
    const first = dump();
    db = await boot();
    expect(dump()).toBe(first);
    expect(list(pinnedDir())).toHaveLength(1);
    // Running the migration body again on encrypted rows changes nothing.
    const { sealAllCredentials } = await import("@/lib/db/helpers/credentialsSeal.js");
    const { getKeyring } = await import("@/lib/credentials/keyring.js");
    expect(sealAllCredentials(db, getKeyring())).toBe(0);
  });

  it("aborts before touching anything when the backup can't be taken", async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only dir
    await schema5WithPlaintext();
    fs.mkdirSync(pinnedDir(), { recursive: true });
    fs.chmodSync(pinnedDir(), 0o555);
    await expect(boot()).rejects.toThrow(
      /Refusing to encrypt stored credentials without a verified backup/,
    );
    fs.chmodSync(pinnedDir(), 0o755);
    // The key file may exist, but the rows are untouched and the migration is still pending.
    delete global._dbAdapter;
    const raw = await import("better-sqlite3").catch(() => null);
    if (raw) {
      const d = new raw.default(dbFiles()[0], { readonly: true });
      expect(d.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get().value).toBe(
        "5",
      );
      expect(
        JSON.parse(d.prepare("SELECT data FROM providerConnections WHERE id='c1'").get().data)
          .apiKey,
      ).toBe(SECRETS.apiKey);
      d.close();
    }
    const db = await boot();
    expect(
      JSON.parse(db.get("SELECT data FROM providerConnections WHERE id='c1'").data).apiKey,
    ).toMatch(/^enc:v1:/);
  });

  it("retries the VACUUM after a crash between the rewrite and the scrub", async () => {
    await schema5WithPlaintext();
    let db = await boot();
    db.run("UPDATE _meta SET value = '0' WHERE key = 'credentialsScrubbed'");
    db = await boot();
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsScrubbed'").value).toBe("1");
  });

  /**
   * Copies of the plaintext DB as older backups: two unpinned (db/backups) and one pinned
   * pre-usage-key-refs restore point (db/pinned-backups). Returns { unpinned, pinned }.
   */
  async function olderBackups() {
    await schema5WithPlaintext();
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    const src = path.join(tempDir, "db", "data.sqlite");
    const unpinned = [
      path.join(tempDir, "db", "backups", "schema-3-to-4-100.0.0-old"),
      path.join(tempDir, "db", "backups", "pre-usage-key-heal-100.0.0-old"),
    ];
    const pinned = path.join(pinnedDir(), "pre-usage-key-refs-100.0.0-old");
    for (const d of [...unpinned, pinned]) {
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(src, path.join(d, "data.sqlite"));
      fs.chmodSync(path.join(d, "data.sqlite"), 0o644);
    }
    return { unpinned, pinned };
  }
  const secretsIn = (file) =>
    Object.values(SECRETS).filter((s) => fs.readFileSync(file).includes(s)).length;
  const ALL = Object.keys(SECRETS).length;

  it("seals unpinned backups in place, keeps every pinned restore point plaintext, all 0600", async () => {
    const { unpinned, pinned } = await olderBackups();
    const db = await boot();
    for (const d of unpinned) {
      expect(fs.existsSync(d)).toBe(true);
      expect(secretsIn(path.join(d, "data.sqlite"))).toBe(0);
    }
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsBackupsSealed'").value).toBe(
      "1",
    );
    // Restore points for older versions stay exactly as taken.
    expect(secretsIn(path.join(pinned, "data.sqlite"))).toBe(ALL);
    const [restore] = list(pinnedDir()).filter((d) => d.startsWith("pre-encrypt-credentials-"));
    const restoreFile = path.join(pinnedDir(), restore, "data.sqlite");
    expect(secretsIn(restoreFile)).toBe(ALL);
    if (process.platform !== "win32") {
      for (const f of [
        restoreFile,
        path.join(pinned, "data.sqlite"),
        ...unpinned.map((d) => path.join(d, "data.sqlite")),
        path.join(tempDir, "db", "data.sqlite"),
      ]) {
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(pinned).mode & 0o777).toBe(0o700);
    }
    // A sealed backup restores into this version and still decrypts.
    db.close();
    delete global._dbAdapter;
    fs.copyFileSync(path.join(unpinned[0], "data.sqlite"), path.join(tempDir, "db", "data.sqlite"));
    for (const f of ["data.sqlite-wal", "data.sqlite-shm"])
      fs.rmSync(path.join(tempDir, "db", f), { force: true });
    await boot();
    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c2")).refreshToken).toBe(SECRETS.refreshToken);
  });

  it("does not touch backups on a rekey-only pass", async () => {
    process.env.CREDENTIALS_KEY = KEY_A;
    await schema5WithPlaintext();
    await boot();
    const old = path.join(tempDir, "db", "backups", "planted-old");
    fs.mkdirSync(old, { recursive: true });
    fs.copyFileSync(
      path.join(pinnedDir(), list(pinnedDir())[0], "data.sqlite"),
      path.join(old, "data.sqlite"),
    );
    const before = fs.readFileSync(path.join(old, "data.sqlite"));
    process.env.CREDENTIALS_KEY = KEY_B;
    process.env.CREDENTIALS_KEY_PREVIOUS = KEY_A;
    await boot();
    expect(fs.readFileSync(path.join(old, "data.sqlite")).equals(before)).toBe(true);
  });

  it("retries sealing the backups next boot when it fails", async () => {
    const { unpinned } = await olderBackups();
    fs.writeFileSync(path.join(unpinned[0], "data.sqlite"), "not a database");
    let db = await boot();
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsBackupsSealed'").value).toBe(
      "0",
    );
    fs.rmSync(unpinned[0], { recursive: true });
    db = await boot();
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsBackupsSealed'").value).toBe(
      "1",
    );
    expect(secretsIn(path.join(unpinned[1], "data.sqlite"))).toBe(0);
  });

  it("purge-plaintext-backups lists every pinned restore point with what it restores, deletes them only with --yes", async () => {
    const { unpinned, pinned } = await olderBackups();
    await boot();
    const { execFileSync } = await import("node:child_process");
    const script = path.join(import.meta.dirname, "../../scripts/purge-plaintext-backups.mjs");
    const env = { ...process.env, DATA_DIR: tempDir };
    const listing = execFileSync(process.execPath, [script], { env }).toString();
    expect(listing).toContain(pinned);
    expect(listing).toMatch(/restore point for v100\.x/);
    expect(listing).toMatch(/restore point for v101\.x and older/);
    expect(fs.existsSync(pinned)).toBe(true);
    execFileSync(process.execPath, [script, "--yes"], { env });
    expect(list(pinnedDir())).toEqual([]);
    for (const d of unpinned) expect(fs.existsSync(d)).toBe(true);
    expect(execFileSync(process.execPath, [script], { env }).toString()).toMatch(/No plaintext/);
  });

  it("heals plaintext written by an older version after a downgrade", async () => {
    await schema5WithPlaintext();
    let db = await boot();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES('c3', 'openai', 'apikey', 'old', 2, 1, ?, ?, ?)`,
      [JSON.stringify({ apiKey: "sk-written-by-older-version-01" }), now, now],
    );
    db = await boot();
    expect(
      JSON.parse(db.get("SELECT data FROM providerConnections WHERE id='c3'").data).apiKey,
    ).toMatch(/^enc:v1:/);
    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c3")).apiKey).toBe(
      "sk-written-by-older-version-01",
    );
  });

  it("rotates: a new key plus the old one in CREDENTIALS_KEY_PREVIOUS re-encrypts everything", async () => {
    process.env.CREDENTIALS_KEY = KEY_A;
    await schema5WithPlaintext();
    await boot();
    process.env.CREDENTIALS_KEY = KEY_B;
    process.env.CREDENTIALS_KEY_PREVIOUS = KEY_A;
    let db = await boot();
    const { keyIdOf, parseKey } = await import("@/lib/credentials/keyring.js");
    const idB = keyIdOf(parseKey(KEY_B, "t"));
    const ids = new Set(
      db
        .all("SELECT data FROM providerConnections")
        .flatMap((r) => [...r.data.matchAll(/enc:v1:([\w-]+):/g)].map((m) => m[1])),
    );
    expect([...ids]).toEqual([idB]);
    delete process.env.CREDENTIALS_KEY_PREVIOUS;
    db = await boot();
    const repo = await import("@/lib/db/index.js");
    expect((await repo.getProviderConnectionById("c1")).apiKey).toBe(SECRETS.apiKey);
  });

  it("rotates with scripts/rotate-credentials-key.mjs (key file mode)", async () => {
    await schema5WithPlaintext();
    await boot();
    const oldKey = fs.readFileSync(keyFile(), "utf8").trim();
    const { execFileSync } = await import("node:child_process");
    const env = { ...process.env, DATA_DIR: tempDir };
    delete env.CREDENTIALS_KEY;
    execFileSync(
      process.execPath,
      [path.join(import.meta.dirname, "../../scripts/rotate-credentials-key.mjs")],
      { env },
    );
    expect(fs.readFileSync(path.join(tempDir, "credentials.key.previous"), "utf8").trim()).toBe(
      oldKey,
    );
    const newKey = fs.readFileSync(keyFile(), "utf8").trim();
    expect(newKey).not.toBe(oldKey);
    const db = await boot();
    const { keyIdOf, parseKey } = await import("@/lib/credentials/keyring.js");
    expect(db.get("SELECT value FROM _meta WHERE key = 'credentialsKeyId'").value).toBe(
      keyIdOf(parseKey(newKey, "t")),
    );
    expect(db.get("SELECT data FROM providerConnections WHERE id='c1'").data).toContain(
      `enc:v1:${keyIdOf(parseKey(newKey, "t"))}:`,
    );
    const out = execFileSync(
      process.execPath,
      [path.join(import.meta.dirname, "../../scripts/rotate-credentials-key.mjs")],
      {
        env: { ...env, CREDENTIALS_KEY: KEY_A },
      },
    ).toString();
    expect(out).toMatch(/CREDENTIALS_KEY_PREVIOUS/);
    // Env mode never prints the key: it is in a 0600 file named in the output.
    const newFile = out.match(/written to (\S+) \(mode 0600\)/)[1];
    const written = fs.readFileSync(newFile, "utf8").trim();
    expect(out).not.toContain(written);
    expect(parseKey(written, "t")).toHaveLength(32);
    if (process.platform !== "win32") expect(fs.statSync(newFile).mode & 0o777).toBe(0o600);
  });

  it("applies on an empty DB", async () => {
    const db = await boot();
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("6");
    expect(list(pinnedDir())).toHaveLength(0);
  });
});

describe.each([
  ["sql.js", "sqljsAdapter.js", "createSqlJsAdapter"],
  ["node:sqlite", "nodeSqliteAdapter.js", "createNodeSqliteAdapter"],
])("migration 006 on %s", (driver, file, factory) => {
  it("encrypts, backs up (pinned) and leaves no plaintext in the file", async () => {
    await schema5WithPlaintext();
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    delete global._credentialsKeyring;
    vi.resetModules();
    const oldBackup = path.join(tempDir, "db", "backups", "schema-3-to-4-old");
    fs.mkdirSync(oldBackup, { recursive: true });
    fs.copyFileSync(path.join(tempDir, "db", "data.sqlite"), path.join(oldBackup, "data.sqlite"));
    const mod = await import(`@/lib/db/adapters/${file}`);
    const adapter = await mod[factory](path.join(tempDir, "db", "data.sqlite"));
    expect(adapter.driver).toBe(driver);
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    await runMigrationOnce(adapter);
    expect(
      JSON.parse(adapter.get("SELECT data FROM providerConnections WHERE id='c2'").data)
        .refreshToken,
    ).toMatch(/^enc:v1:/);
    expect(list(pinnedDir()).filter((d) => d.startsWith("pre-encrypt-credentials-"))).toHaveLength(
      1,
    );
    adapter.close();
    expect(plaintextHits()).toBe(0);
    const bak = fs.readFileSync(path.join(oldBackup, "data.sqlite"));
    expect(Object.values(SECRETS).filter((s) => bak.includes(s))).toEqual([]);
    expect(bak.includes("enc:v1:")).toBe(true);
  });
});

describe("repos", () => {
  it("connections: writes encrypt (incl. a token refresh), reads decrypt", async () => {
    const db = await boot();
    const repo = await import("@/lib/db/index.js");
    const c = await repo.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: "a@example.test",
      accessToken: SECRETS.accessToken,
      refreshToken: SECRETS.refreshToken,
      providerSpecificData: { clientSecret: "cs-FAKE-000000001", region: "us" },
    });
    expect(c.accessToken).toBe(SECRETS.accessToken);
    await repo.updateProviderConnection(c.id, {
      accessToken: "new-access-FAKE-0000001",
      refreshToken: "new-refresh-FAKE-000001",
    });
    const raw = db.get("SELECT data FROM providerConnections WHERE id = ?", [c.id]).data;
    for (const s of ["new-access-FAKE-0000001", "new-refresh-FAKE-000001", "cs-FAKE-000000001"])
      expect(raw).not.toContain(s);
    const got = await repo.getProviderConnectionById(c.id);
    expect(got).toMatchObject({
      accessToken: "new-access-FAKE-0000001",
      refreshToken: "new-refresh-FAKE-000001",
    });
    expect(got.providerSpecificData).toEqual({ clientSecret: "cs-FAKE-000000001", region: "us" });
    expect((await repo.getProviderConnections({ provider: "claude" }))[0].refreshToken).toBe(
      "new-refresh-FAKE-000001",
    );
    // A reorder/cleanup round trip keeps the values encrypted and readable.
    await repo.cleanupProviderConnections();
    await repo.reorderProviderConnections("claude");
    expect((await repo.getProviderConnectionById(c.id)).accessToken).toBe(
      "new-access-FAKE-0000001",
    );
  });

  it("a ciphertext moved to another row is refused on read", async () => {
    const db = await boot();
    const repo = await import("@/lib/db/index.js");
    const a = await repo.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "a",
      apiKey: "sk-a-FAKE-000000000",
    });
    const b = await repo.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "b",
      apiKey: "sk-b-FAKE-000000000",
    });
    const dataA = db.get("SELECT data FROM providerConnections WHERE id = ?", [a.id]).data;
    db.run("UPDATE providerConnections SET data = ? WHERE id = ?", [dataA, b.id]);
    await expect(repo.getProviderConnectionById(b.id)).rejects.toThrow(/failed authentication/);
  });

  it("settings and proxy pools: secrets encrypted, other fields plain", async () => {
    const db = await boot();
    const repo = await import("@/lib/db/index.js");
    await repo.updateSettings({
      notifyResendKey: "re_FAKE_000000000001",
      updateWebhookUrl: "https://hook.test/deploy?token=FAKE01",
      tunnelUrl: "https://t.test",
    });
    const raw = JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data);
    expect(raw.notifyResendKey).toMatch(/^enc:v1:/);
    expect(raw.updateWebhookUrl).toMatch(/^enc:v1:/);
    expect(raw.tunnelUrl).toBe("https://t.test");
    const s = await repo.getSettings();
    expect(s.notifyResendKey).toBe("re_FAKE_000000000001");
    await repo.updateSettings({ tunnelUrl: "" });
    expect((await repo.getSettings()).updateWebhookUrl).toBe(
      "https://hook.test/deploy?token=FAKE01",
    );

    const p = await repo.createProxyPool({
      name: "x",
      proxyUrl: "http://u:pw-FAKE-0001@proxy.test:1",
    });
    expect(db.get("SELECT data FROM proxyPools WHERE id = ?", [p.id]).data).not.toContain(
      "pw-FAKE-0001",
    );
    await repo.updateProxyPool(p.id, { name: "y" });
    expect((await repo.getProxyPools())[0]).toMatchObject({
      name: "y",
      proxyUrl: "http://u:pw-FAKE-0001@proxy.test:1",
    });
  });

  it("export returns decrypted values with a warning; import re-encrypts and refuses foreign envelopes", async () => {
    await schema5WithPlaintext();
    const db = await boot();
    const repo = await import("@/lib/db/index.js");
    const out = await repo.exportDb();
    expect(out._warning).toMatch(/plaintext/);
    expect(out.providerConnections.find((c) => c.id === "c1").apiKey).toBe(SECRETS.apiKey);
    expect(out.proxyPools[0].proxyUrl).toContain(SECRETS.proxyPass);
    expect(out.settings.notifySmtpPassword).toBeUndefined(); // never exported (notify config)
    expect(out.settings.oidcClientSecret).toBe(SECRETS.oidc);

    await repo.importDb(out);
    expect(db.get("SELECT data FROM providerConnections WHERE id='c1'").data).not.toContain(
      SECRETS.apiKey,
    );
    expect((await repo.getProviderConnectionById("c1")).apiKey).toBe(SECRETS.apiKey);
    expect(db.get("SELECT data FROM settings WHERE id = 1").data).not.toContain(SECRETS.oidc);

    const foreign = structuredClone(out);
    foreign.providerConnections[0].apiKey =
      "enc:v1:otherKeyId0:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA";
    await expect(repo.importDb(foreign)).rejects.toThrow(/No credentials key/);
    expect((await repo.getProviderConnectionById("c1")).apiKey).toBe(SECRETS.apiKey);
  });
});
