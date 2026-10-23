// The Playground runs AS a real API key: real DB, real handleChat (only the upstream call,
// handleChatCore, is stubbed and records usage like chatCore does). The key is resolved
// server-side and never echoed; its access list, budget and usage attribution apply as
// on /v1; the "Playground" key is auto-created once; the key list carries no secrets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-session"),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async ({ apiKey, modelInfo, connectionId, clientRawRequest }) => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      provider: modelInfo.provider,
      model: modelInfo.model,
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      connectionId,
      apiKey,
      endpoint: clientRawRequest?.endpoint,
    });
    return {
      success: true,
      response: Response.json({ choices: [{ message: { content: "ok" } }] }),
    };
  }),
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let route;
let keysRoute;
let modelsRoute;
let pgKeys;
let limits;
let budgets;
let budgetsRepo;
let cv;
let billing;
let adapter;
let open;
let restricted;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-playground-keys-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  route = await import("@/app/api/dashboard/chat/completions/route.js");
  keysRoute = await import("@/app/api/dashboard/chat/keys/route.js");
  modelsRoute = await import("@/app/api/dashboard/chat/models/route.js");
  pgKeys = await import("@/lib/playground/keys.js");
  limits = await import("@/lib/playground/limits.js");
  budgets = await import("@/lib/budgets/index.js");
  budgetsRepo = await import("@/lib/db/repos/budgetsRepo.js");
  cv = await import("@/lib/customerView/index.js");
  billing = await import("@/lib/billing/index.js");
  await db.createProviderConnection({
    provider: "openai",
    name: "Upstream",
    authType: "apikey",
    apiKey: "sk-upstream-fixture",
    isActive: true,
    testStatus: "active",
  });
  open = await db.createApiKey("acme", "machine-fixture");
  restricted = await db.createApiKey("limited", "machine-fixture");
  await db.updateApiKey(restricted.id, {
    access: { restricted: true, allow: ["openai/gpt-4o-mini"] },
  });
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._regentBudgetState;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM budgets");
  budgets.invalidateBudgetCache({ counters: true });
  billing.invalidateBillingCache();
  limits.resetPlaygroundLimits();
});

const HOST = "localhost:20137";
const SESSION = { host: HOST, origin: `http://${HOST}`, cookie: "auth_token=valid-session" };
const getKeys = (headers = SESSION) =>
  keysRoute.GET(new Request(`http://${HOST}/api/dashboard/chat/keys`, { headers }));
function post(body) {
  return route.POST(
    new Request(`http://${HOST}/api/dashboard/chat/completions`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        "content-type": "application/json",
        cookie: "auth_token=valid-session",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        model: "openai/gpt-4o",
        ...body,
      }),
    }),
  );
}

describe("running as the picked key", () => {
  it("works, attributes usage to that key (customer view + spend), never echoes the secret", async () => {
    const res = await post({ keyId: open.id });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(open.key);
    const row = adapter.get("SELECT apiKey, endpoint FROM usageHistory ORDER BY id DESC LIMIT 1");
    expect(row.apiKey).toBe(`id:${open.id}`);
    expect(row.endpoint).toBe("/api/dashboard/chat/completions");
    const view = await cv.getCustomerUsage(await db.getApiKeyById(open.id));
    expect(view.period.requests).toBe(1);
    expect((await billing.getKeySpend(open.id)).requests).toBe(1);
  });

  it("refuses a model outside a restricted key's access list (403)", async () => {
    const denied = await post({ keyId: restricted.id, model: "openai/gpt-4o" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(restricted.key);
    expect((await post({ keyId: restricted.id, model: "openai/gpt-4o-mini" })).status).toBe(200);
  });

  it("stops a key over its hard budget with 429", async () => {
    await budgetsRepo.setBudget(
      budgetsRepo.keyScope(open.id),
      budgets.validateBudget({ spendLimit: 0.01, hardStop: true }).value,
    );
    budgets.invalidateBudgetCache({ counters: true });
    expect((await post({ keyId: open.id })).status).toBe(200); // spends past the limit
    budgets.invalidateBudgetCache({ counters: true });
    const res = await post({ keyId: open.id });
    expect(res.status).toBe(429);
  });

  it("gives 404 for an unknown or deleted key and 403 for a disabled one", async () => {
    expect((await post({ keyId: "00000000-0000-0000-0000-000000000000" })).status).toBe(404);
    const gone = await db.createApiKey("gone", "machine-fixture");
    await db.deleteApiKey(gone.id);
    expect((await post({ keyId: gone.id })).status).toBe(404);
    const off = await db.createApiKey("off", "machine-fixture");
    await db.updateApiKey(off.id, { isActive: false });
    expect((await post({ keyId: off.id })).status).toBe(403);
  });
});

describe("the Playground key", () => {
  it("is created on first use, once, with no price plan, and is a normal key", async () => {
    const before = (await db.getApiKeys()).length;
    const [a, b] = await Promise.all([pgKeys.ensurePlaygroundKey(), pgKeys.ensurePlaygroundKey()]);
    expect(a.id).toBe(b.id);
    expect((await post({ keyId: "playground" })).status).toBe(200);
    const after = await db.getApiKeys();
    expect(after.length).toBe(before + 1);
    const pg = after.find((k) => k.name === "Playground");
    expect(pg.id).toBe(a.id);
    expect(pg.access.restricted).toBe(false);
    const row = adapter.get("SELECT apiKey FROM usageHistory ORDER BY id DESC LIMIT 1");
    expect(row.apiKey).toBe(`id:${pg.id}`);
    // Renamed, it is still the Playground key (stable marker, not just the name).
    await db.updateApiKey(pg.id, { name: "My playground" });
    expect((await pgKeys.ensurePlaygroundKey()).id).toBe(pg.id);
  });

  it("the key list has ids and names only, never a secret", async () => {
    const res = await getKeys();
    const text = await res.text();
    for (const k of await db.getApiKeys()) expect(text).not.toContain(k.key);
    const { keys } = JSON.parse(text);
    expect(Object.keys(keys[0]).sort((x, y) => x.localeCompare(y))).toEqual([
      "id",
      "isActive",
      "name",
      "playground",
      "restricted",
    ]);
    expect(keys.filter((k) => k.playground)).toHaveLength(1);
  });

  it("before it exists, the list offers the placeholder", async () => {
    adapter.run("DELETE FROM _meta WHERE key = 'playgroundKeyId'");
    adapter.run("DELETE FROM apiKeys WHERE name = 'My playground'");
    const { keys } = await (await getKeys()).json();
    expect(keys[0]).toMatchObject({ id: "playground", name: "Playground", playground: true });
  });

  it("never adopts a key just because it is named Playground", async () => {
    const lookalike = await db.createApiKey("Playground", "machine-fixture");
    const { keys } = await (await getKeys()).json();
    expect(keys.find((k) => k.id === lookalike.id).playground).toBe(false);
    const pg = await pgKeys.ensurePlaygroundKey();
    expect(pg.id).not.toBe(lookalike.id);
    expect((await post({ keyId: "playground" })).status).toBe(200);
    const row = adapter.get("SELECT apiKey FROM usageHistory ORDER BY id DESC LIMIT 1");
    expect(row.apiKey).toBe(`id:${pg.id}`);
  });
});

describe("session gate on the helper routes", () => {
  it("both refuse without a session, and with requireLogin off for a non-local caller", async () => {
    const noCookie = { host: HOST, origin: `http://${HOST}` };
    expect((await getKeys(noCookie)).status).toBe(401);
    await db.updateSettings({ requireLogin: false });
    try {
      // A tunnel / DNS-rebinding style caller: not loopback, so still refused.
      const remote = { host: "evil.example", origin: "http://evil.example" };
      expect((await getKeys(remote)).status).toBe(401);
      const res = await modelsRoute.POST(
        new Request("http://evil.example/api/dashboard/chat/models", {
          method: "POST",
          headers: { ...remote, "content-type": "application/json" },
          body: JSON.stringify({ keyId: open.id, models: [] }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      await db.updateSettings({ requireLogin: true });
    }
  });
});

describe("model filter", () => {
  const ask = (body, headers = {}) =>
    modelsRoute.POST(
      new Request(`http://${HOST}/api/dashboard/chat/models`, {
        method: "POST",
        headers: { ...SESSION, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );

  it("never creates a key: a stale or missing Playground binding gets every id", async () => {
    const models = ["openai/gpt-4o"];
    adapter.run(
      "INSERT INTO _meta(key, value) VALUES('playgroundKeyId', 'deleted-key-id') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const before = (await db.getApiKeys()).length;
    expect((await (await ask({ keyId: "playground", models })).json()).models).toEqual(models);
    adapter.run("DELETE FROM _meta WHERE key = 'playgroundKeyId'");
    expect((await (await ask({ keyId: "playground", models })).json()).models).toEqual(models);
    expect((await db.getApiKeys()).length).toBe(before);
  });

  it("is same-origin JSON only", async () => {
    const models = ["openai/gpt-4o"];
    expect((await ask({ keyId: open.id, models }, { origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await ask({ keyId: open.id, models }, { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await ask({ keyId: open.id, models }, { cookie: "" })).status).toBe(401);
  });

  it("returns what a restricted key may call, everything for an open key", async () => {
    const models = ["openai/gpt-4o", "openai/gpt-4o-mini"];
    expect((await (await ask({ keyId: restricted.id, models })).json()).models).toEqual([
      "openai/gpt-4o-mini",
    ]);
    expect((await (await ask({ keyId: open.id, models })).json()).models).toEqual(models);
    expect((await ask({ keyId: "missing-key", models })).status).toBe(404);
    expect((await ask({ keyId: "../x", models })).status).toBe(400);
    expect((await ask("nope")).status).toBe(400);
  });
});
