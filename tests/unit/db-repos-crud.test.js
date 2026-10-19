// CRUD round-trips for the SQLite repos (src/lib/db/repos/*) on a fresh, empty DB.
// Each file gets its own DATA_DIR so the adapter singleton starts from zero.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-db-repos-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("apiKeysRepo", () => {
  it("creates, reads, updates access, validates and deletes a key", async () => {
    await expect(db.createApiKey("no-machine", "")).rejects.toThrow(/machineId/);

    const created = await db.createApiKey("ci", "machine-abc");
    expect(created.key).toMatch(/^sk-/);
    expect(created.access).toEqual({ restricted: false, allow: [] });

    expect(await db.getApiKeyById(created.id)).toMatchObject({ name: "ci", isActive: true });
    expect(await db.getApiKeyByKey(created.key)).toMatchObject({ id: created.id });
    expect(await db.getApiKeyByKey("")).toBeNull();
    expect(await db.validateApiKey(created.key)).toBe(true);
    expect(await db.validateApiKey("sk-nope")).toBe(false);

    const updated = await db.updateApiKey(created.id, { isActive: false, access: { restricted: true, allow: ["cc/*"] } });
    expect(updated.isActive).toBe(false);
    expect(updated.access.restricted).toBe(true);
    expect(await db.validateApiKey(created.key)).toBe(false);
    expect(await db.updateApiKey("missing", { isActive: true })).toBeNull();

    expect(await db.deleteApiKey(created.id)).toBe(true);
    expect(await db.deleteApiKey(created.id)).toBe(false);
    expect(await db.getApiKeyById(created.id)).toBeNull();
  });
});

describe("connectionsRepo", () => {
  it("round-trips an apikey connection and keeps extra fields in the JSON column", async () => {
    const conn = await db.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "main",
      apiKey: "sk-test-FAKE-SECRET",
      providerSpecificData: { region: "eu" },
    });
    expect(conn.id).toBeTruthy();

    const fetched = await db.getProviderConnectionById(conn.id);
    expect(fetched).toMatchObject({ provider: "openai", name: "main", apiKey: "sk-test-FAKE-SECRET", isActive: true });
    expect(fetched.providerSpecificData).toEqual({ region: "eu" });

    // Secrets are not encrypted at rest: they live in the plaintext `data` JSON column.
    // The DB file is protected by filesystem permissions only (documents current behaviour).
    const raw = adapter.get(`SELECT data FROM providerConnections WHERE id = ?`, [conn.id]);
    expect(JSON.parse(raw.data).apiKey).toBe("sk-test-FAKE-SECRET");

    const list = await db.getProviderConnections({ provider: "openai" });
    expect(list.map((c) => c.id)).toContain(conn.id);
  });

  it("dedupes apikey connections by name within a provider", async () => {
    const a = await db.createProviderConnection({ provider: "groq", authType: "apikey", name: "k", apiKey: "one" });
    const b = await db.createProviderConnection({ provider: "groq", authType: "apikey", name: "k", apiKey: "two" });
    expect(b.id).toBe(a.id);
    expect((await db.getProviderConnectionById(a.id)).apiKey).toBe("two");
    expect(await db.getProviderConnections({ provider: "groq" })).toHaveLength(1);
  });

  it("activation clears error state; update of missing id returns null", async () => {
    const c = await db.createProviderConnection({ provider: "mistral", authType: "apikey", name: "m", apiKey: "x" });
    await db.updateProviderConnection(c.id, { testStatus: "error", lastError: "boom", errorCode: 429, rateLimitedUntil: "2099-01-01" });
    const healed = await db.updateProviderConnection(c.id, { testStatus: "active" });
    expect(healed).toMatchObject({ testStatus: "active", lastError: null, errorCode: null, rateLimitedUntil: null });
    expect(await db.updateProviderConnection("missing", { name: "x" })).toBeNull();
  });

  it("deletes single and per-provider connections", async () => {
    const x = await db.createProviderConnection({ provider: "together", authType: "apikey", name: "a", apiKey: "1" });
    await db.createProviderConnection({ provider: "together", authType: "apikey", name: "b", apiKey: "2" });
    expect(await db.deleteProviderConnection(x.id)).toBe(true);
    expect(await db.deleteProviderConnection(x.id)).toBe(false);
    expect(await db.deleteProviderConnectionsByProvider("together")).toBe(1);
    expect(await db.getProviderConnections({ provider: "together" })).toEqual([]);
  });
});

describe("nodesRepo / proxyPoolsRepo / combosRepo", () => {
  it("provider node CRUD", async () => {
    const node = await db.createProviderNode({ id: "openai-compatible-chat-t1", type: "openai-compatible", name: "N", prefix: "n", apiType: "chat", baseUrl: "https://example.com/v1" });
    expect(await db.getProviderNodeById(node.id)).toMatchObject({ name: "N", prefix: "n" });
    expect((await db.updateProviderNode(node.id, { name: "N2" })).name).toBe("N2");
    expect((await db.getProviderNodes({ type: "openai-compatible" })).map((n) => n.id)).toContain(node.id);
    await db.deleteProviderNode(node.id);
    expect(await db.getProviderNodeById(node.id)).toBeNull();
  });

  it("proxy pool CRUD with filters", async () => {
    const pool = await db.createProxyPool({ name: "P", proxyUrl: "http://proxy.example:8080", isActive: false });
    expect(await db.getProxyPoolById(pool.id)).toMatchObject({ name: "P", isActive: false, type: "http", strictProxy: false });
    expect((await db.getProxyPools({ isActive: false })).map((p) => p.id)).toContain(pool.id);
    expect((await db.getProxyPools({ isActive: true })).map((p) => p.id)).not.toContain(pool.id);
    expect((await db.updateProxyPool(pool.id, { strictProxy: true })).strictProxy).toBe(true);
    expect(await db.updateProxyPool("missing", { name: "x" })).toBeNull();
    await db.deleteProxyPool(pool.id);
    expect(await db.getProxyPoolById(pool.id)).toBeNull();
  });

  it("combo CRUD keeps models as an array", async () => {
    const combo = await db.createCombo({ name: "fast", models: ["cc/a", "cx/b"] });
    expect(await db.getComboByName("fast")).toMatchObject({ id: combo.id, models: ["cc/a", "cx/b"] });
    expect((await db.updateCombo(combo.id, { models: ["cc/a"] })).models).toEqual(["cc/a"]);
    expect((await db.getComboById(combo.id)).models).toEqual(["cc/a"]);
    expect(await db.updateCombo("missing", {})).toBeNull();
    expect(await db.deleteCombo(combo.id)).toBe(true);
    expect(await db.deleteCombo(combo.id)).toBe(false);
  });
});

describe("kv-backed repos", () => {
  it("disabled models: disable merges, enable removes, empty enable clears", async () => {
    const repo = await import("@/lib/db/repos/disabledModelsRepo.js");
    await repo.disableModels("cc", ["a", "b"]);
    await repo.disableModels("cc", ["b", "c"]);
    expect(await repo.getDisabledByProvider("cc")).toEqual(["a", "b", "c"]);
    await repo.enableModels("cc", ["a"]);
    expect(await repo.getDisabledByProvider("cc")).toEqual(["b", "c"]);
    await repo.enableModels("cc", ["b", "c"]);
    expect(await repo.getDisabledByProvider("cc")).toEqual([]);
    await repo.disableModels("cx", ["z"]);
    await repo.enableModels("cx", []);
    expect(await repo.getDisabledModels()).toEqual({});
    await repo.disableModels(null, ["x"]); // ignored
    await repo.disableModels("cc", "not-array"); // ignored
    expect(await repo.getDisabledModels()).toEqual({});
  });

  it("aliases, custom models and MITM aliases round-trip", async () => {
    await db.setModelAlias("fast", "cc/claude-haiku");
    expect((await db.getModelAliases()).fast).toBe("cc/claude-haiku");
    await db.deleteModelAlias("fast");
    expect((await db.getModelAliases()).fast).toBeUndefined();

    const repo = await import("@/lib/db/repos/aliasRepo.js");
    expect(await repo.addCustomModel({ providerAlias: "oc", id: "m1" })).toBe(true);
    expect(await repo.addCustomModel({ providerAlias: "oc", id: "m1", name: "Model 1" })).toBe(false);
    expect((await repo.getCustomModels()).find((m) => m.id === "m1")).toMatchObject({ name: "Model 1", type: "llm" });
    expect(await repo.updateCustomModel({ providerAlias: "oc", id: "m1", name: "" })).toMatchObject({ name: "m1" });
    expect(await repo.updateCustomModel({ providerAlias: "oc", id: "nope" })).toBeNull();
    await repo.deleteCustomModel({ providerAlias: "oc", id: "m1" });
    expect(await repo.getCustomModels()).toEqual([]);

    await repo.setMitmAliasAll("cursor", { "gpt-5": "cc/claude" });
    expect(await repo.getMitmAlias("cursor")).toEqual({ "gpt-5": "cc/claude" });
    expect(await repo.getMitmAlias("unknown")).toEqual({});
  });

  it("pricing overrides merge per provider and reset", async () => {
    const repo = await import("@/lib/db/repos/pricingRepo.js");
    await repo.updatePricing({ zz: { m1: { input: 1, output: 2 } } });
    await repo.updatePricing({ zz: { m2: { input: 3, output: 4 } } });
    let pricing = await repo.getPricing();
    expect(pricing.zz).toMatchObject({ m1: { input: 1 }, m2: { input: 3 } });
    expect(await repo.getPricingForModel("zz", "m2")).toMatchObject({ output: 4 });
    await repo.resetPricing("zz", "m1");
    pricing = await repo.getPricing();
    expect(pricing.zz?.m1).toBeUndefined();
    await repo.resetPricing("zz", "m2");
    expect((await repo.getPricing()).zz).toBeUndefined();
    await repo.updatePricing({ zz: { m3: { input: 1 } } });
    expect(await repo.resetAllPricing()).toEqual({});
  });
});

describe("settingsRepo", () => {
  it("merges updates atomically and keeps webhook secrets out of exports", async () => {
    const before = await db.getSettings();
    expect(before.requireLogin).toBeDefined();
    await db.updateSettings({ cloudEnabled: true, cloudUrl: "https://cloud.example", updateWebhookToken: "secret-tok" });
    await db.updateSettings({ requireLogin: false });
    const after = await db.getSettings();
    expect(after).toMatchObject({ cloudEnabled: true, requireLogin: false });

    const repo = await import("@/lib/db/repos/settingsRepo.js");
    expect(await repo.isCloudEnabled()).toBe(true);
    expect(await repo.getCloudUrl()).toBe("https://cloud.example");
    const exported = await repo.exportSettings();
    for (const k of repo.NON_EXPORTED_SETTING_KEYS) expect(exported).not.toHaveProperty(k);
    expect(exported.cloudUrl).toBe("https://cloud.example");
  });
});

describe("requestDetailsRepo", () => {
  it("redacts credential headers", async () => {
    const { __test__ } = await import("@/lib/db/repos/requestDetailsRepo.js");
    const out = __test__.sanitizeHeaders({ Authorization: "Bearer sk-live", "x-api-key": "k", Cookie: "s=1", accept: "json" });
    expect(JSON.stringify(out)).not.toMatch(/sk-live|s=1/);
    expect(out.accept).toBe("json");
  });
});

describe("migrations on an empty DB", () => {
  it("stamps the latest schema version and is idempotent", async () => {
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const row = adapter.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(Number(row.value)).toBe(latestVersion());
    await runMigrationOnce(adapter); // same adapter → no-op
    expect(Number(adapter.get(`SELECT value FROM _meta WHERE key='schemaVersion'`).value)).toBe(latestVersion());
  });
});
