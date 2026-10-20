// Customer view (src/lib/customerView, GET /api/customer/usage): a key sees only its own
// data, bad/disabled/excluded keys get one generic 401, failures are rate-limited per IP,
// nothing upstream-side (provider, connection, endpoint, key string) leaks, spend follows
// budget status, and the dashboard gate still refuses API-key bearers on dashboard routes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let adapter;
let repo;
let budgets;
let cv;
let route;
let keyA;
let keyB;
let ipSeq = 0;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-customer-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/budgetsRepo.js");
  budgets = await import("@/lib/budgets/index.js");
  cv = await import("@/lib/customerView/index.js");
  route = await import("@/app/api/customer/usage/route.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keyA = await db.createApiKey("acme", "machine-fixture");
  keyB = await db.createApiKey("globex", "machine-fixture");
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

beforeEach(async () => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM budgets");
  budgets.invalidateBudgetCache({ counters: true });
  await db.updateSettings({ customerViewEnabled: true, customerViewBlockedKeys: [] });
  await db.updateApiKey(keyA.id, { isActive: true });
});

// `model` is what the customer requested; the stored (resolved) model is always a secret.
// `charge` is what the customer pays (per-key pricing); it defaults to the cost.
function usage(apiKey, { cost = 1, charge = cost, model = "gpt-x", tokens = 100, status = "ok" } = {}) {
  adapter.run(
    "INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, charge, status, meta) VALUES(?, 'secret-provider', 'resolved-secret-model', 'conn-secret', ?, '/v1/chat/completions', ?, 10, ?, ?, ?, ?)",
    [new Date().toISOString(), apiKey, tokens, cost, charge, status, JSON.stringify({ traceId: "trace-secret", requestedModel: model })],
  );
}

// Each call uses its own trusted client IP unless one is given, so the limiter only
// engages where a test means it to.
function get(key, { ip = `10.0.0.${++ipSeq}`, header } = {}) {
  process.env.NINEROUTER_PEER_TOKEN = "peer-token-fixture";
  const headers = new Headers({ "x-9r-peer-token": "peer-token-fixture", "x-9r-real-ip": ip });
  if (header) headers.set("authorization", header);
  else if (key) headers.set("authorization", `Bearer ${key}`);
  return route.GET(new Request("http://localhost/api/customer/usage", { headers }));
}

describe("matchKey", () => {
  it("finds only an exact key", () => {
    const keys = [keyA, keyB];
    expect(cv.matchKey(keyA.key, keys)?.id).toBe(keyA.id);
    expect(cv.matchKey(keyB.key, keys)?.id).toBe(keyB.id);
    expect(cv.matchKey(keyA.key.slice(0, -1), keys)).toBeNull();
    expect(cv.matchKey(`${keyA.key}x`, keys)).toBeNull();
    expect(cv.matchKey("", keys)).toBeNull();
    expect(cv.matchKey(null, keys)).toBeNull();
  });

  it("reads the key from a Bearer header only", () => {
    const req = (h) => new Request("http://x/api/customer/usage?key=abc", { headers: h });
    expect(cv.bearerFrom(req({ authorization: "Bearer k1" }))).toBe("k1");
    expect(cv.bearerFrom(req({ "x-api-key": "k1" }))).toBeNull();
    expect(cv.bearerFrom(req({}))).toBeNull();
  });
});

describe("GET /api/customer/usage", () => {
  it("returns only the presenting key's data", async () => {
    usage(keyA.key, { cost: 2, model: "model-a" });
    usage(keyA.key, { cost: 3, model: "model-a" });
    usage(keyB.key, { cost: 50, model: "model-b" });

    const a = await (await get(keyA.key)).json();
    expect(a.period.requests).toBe(2);
    expect(a.period.spend).toBe(5);
    expect(a.byModel.map((m) => m.model)).toEqual(["model-a"]);
    expect(a.recent).toHaveLength(2);
    expect(a.daily.reduce((s, d) => s + d.requests, 0)).toBe(2);

    const b = await (await get(keyB.key)).json();
    expect(b.period.spend).toBe(50);
    expect(b.byModel.map((m) => m.model)).toEqual(["model-b"]);
    expect(b.recent).toHaveLength(1);
  });

  it("never returns key strings, provider, connection, endpoint or trace ids", async () => {
    usage(keyA.key);
    const res = await get(keyA.key);
    const text = await res.text();
    for (const secret of [keyA.key, keyB.key, "secret-provider", "conn-secret", "trace-secret", "/v1/chat", "resolved-secret-model", keyA.id]) {
      expect(text).not.toContain(secret);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports budget spend from budget status and limits without contact details", async () => {
    await repo.setBudget(repo.keyScope(keyA.id), {
      ...budgets.validateBudget({ spendLimit: 10, hardStop: true, contactEmail: "c@acme.io", period: "day" }).value,
    });
    budgets.invalidateBudgetCache({ counters: true });
    usage(keyA.key, { cost: 4 });
    const body = await (await get(keyA.key)).json();
    expect(body.budget).toMatchObject({ spendLimit: 10, period: "day", hardStop: true, state: "ok" });
    expect(body.budget.ratio).toBeCloseTo(0.4);
    expect(body.period.spend).toBe(4);
    expect(JSON.stringify(body)).not.toContain("c@acme.io");
    expect(Date.parse(body.period.resetsAt)).toBeGreaterThan(Date.now());
  });

  it("maps stored status text to ok / error / an HTTP code, never free text", async () => {
    expect(cv.publicStatus("ok")).toBe("ok");
    expect(cv.publicStatus("success")).toBe("ok");
    expect(cv.publicStatus("429")).toBe("429");
    expect(cv.publicStatus("error: upstream 401 https://secret.host")).toBe("401");
    expect(cv.publicStatus("connection reset by https://secret.host")).toBe("error");
    usage(keyA.key, { status: "error: upstream 401 https://secret.host/v1" });
    const text = await (await get(keyA.key)).text();
    expect(text).not.toContain("secret.host");
    expect(JSON.parse(text).recent[0].status).toBe("401");
  });

  it("headline totals add up with the breakdown and chart, with or without a budget", async () => {
    usage(keyA.key, { cost: 2, model: "m1" });
    usage(keyA.key, { cost: 3, model: "m2" });
    const first = await (await get(keyA.key)).json();
    expect(first.period).toMatchObject({ spend: 5, requests: 2 });
    usage(keyA.key, { cost: 4, model: "m1" });
    const b = await (await get(keyA.key)).json(); // no stale counter
    expect(b.period).toMatchObject({ spend: 9, requests: 3 });
    expect(b.byModel.reduce((s, m) => s + m.spend, 0)).toBe(b.period.spend);
    expect(b.byModel.reduce((s, m) => s + m.requests, 0)).toBe(b.period.requests);
    expect(b.daily.reduce((s, d) => s + d.spend, 0)).toBe(9);
  });

  it("shows the charge, never the upstream cost (a NULL charge counts as 0)", async () => {
    usage(keyA.key, { cost: 100, charge: null });
    usage(keyA.key, { cost: 100, charge: 7 });
    const body = await (await get(keyA.key)).json();
    expect(body.period.spend).toBe(7);
    expect(body.recent.map((r) => r.spend).sort()).toEqual([0, 7]);
    expect(body.byModel[0].spend).toBe(7);
  });

  it("rows from before per-key pricing show their cost as spend after migration 004", async () => {
    const m004 = (await import("@/lib/db/migrations/004-key-pricing.js")).default;
    adapter.exec("ALTER TABLE usageHistory DROP COLUMN charge");
    cv.resetSchemaCache();
    try {
      adapter.run(
        "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, meta) VALUES(?, 'p', 'm', ?, 10, 10, 2.5, 'ok', ?)",
        [new Date().toISOString(), keyA.key, JSON.stringify({ requestedModel: "old-model" })],
      );
      adapter.transaction(() => m004.up(adapter));
      cv.resetSchemaCache();
      usage(keyA.key, { cost: 1, charge: 1.5, model: "new-model" });
      const body = await (await get(keyA.key)).json();
      expect(body.period.spend).toBe(4);
      expect(body.byModel.find((m) => m.model === "old-model").spend).toBe(2.5);
    } finally {
      cv.resetSchemaCache();
    }
  });

  it("answers the same generic 401 for unknown, missing, inactive, excluded keys and feature off", async () => {
    const bodies = [];
    const check = async (res) => {
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    };
    await check(await get("sk-not-a-key"));
    await check(await get(null));
    await check(await get(null, { header: `Basic ${keyA.key}` }));
    await db.updateApiKey(keyA.id, { isActive: false });
    await check(await get(keyA.key));
    await db.updateApiKey(keyA.id, { isActive: true });
    await db.updateSettings({ customerViewBlockedKeys: [keyA.id] });
    await check(await get(keyA.key));
    expect((await get(keyB.key)).status).toBe(200);
    await db.updateSettings({ customerViewEnabled: false, customerViewBlockedKeys: [] });
    await check(await get(keyA.key));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(keyA.key);
  });

  it("locks an IP out after repeated failures, and a valid key doesn't reset it", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < 4; i++) expect((await get("bad", { ip })).status).toBe(401);
    expect((await get(keyA.key, { ip })).status).toBe(200);
    expect((await get("bad", { ip })).status).toBe(401); // 5th failure locks
    const locked = await get(keyA.key, { ip });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another IP is unaffected.
    expect((await get(keyA.key, { ip: "203.0.113.8" })).status).toBe(200);
  });

  it("doesn't lock everyone out when the client IP is unknown (no custom-server)", async () => {
    delete process.env.NINEROUTER_PEER_TOKEN;
    const req = (key) =>
      route.GET(
        new Request("http://localhost/api/customer/usage", {
          headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "198.51.100.1" },
        }),
      );
    for (let i = 0; i < 12; i++) expect((await req("bad")).status).toBe(401);
    expect((await req(keyA.key)).status).toBe(200);
  });
});

describe("combo requests", () => {
  it("show the requested combo name, never the resolved upstream model", async () => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    const trace = await import("@/lib/requestTrace.js");
    // Chat path: the requested name comes from the routing trace (setRequestedModel).
    const t = trace.startTrace({ endpoint: "/v1/chat/completions" });
    await trace.runWithTrace(t, async () => {
      trace.setRequestedModel("my-combo");
      await saveRequestUsage({
        provider: "openai",
        model: "gpt-upstream-hidden",
        apiKey: keyA.key,
        traceId: t.id,
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    // Explicit requestedModel (embeddings/images/combo members).
    await saveRequestUsage({
      provider: "openai",
      model: "embed-upstream-hidden",
      requestedModel: "my-alias",
      apiKey: keyA.key,
      tokens: { prompt_tokens: 10, completion_tokens: 0 },
    });
    // A row from before requestedModel was recorded.
    adapter.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status, meta) VALUES(?, 'p', 'legacy-upstream-hidden', ?, 1, 1, 0, 'ok', '{}')",
      [new Date().toISOString(), keyA.key],
    );

    const res = await get(keyA.key);
    const text = await res.text();
    for (const hidden of ["gpt-upstream-hidden", "embed-upstream-hidden", "legacy-upstream-hidden", "openai"]) {
      expect(text).not.toContain(hidden);
    }
    const body = JSON.parse(text);
    expect(body.byModel.map((m) => m.model).sort()).toEqual(["Unknown model", "my-alias", "my-combo"]);
    expect(body.recent.map((r) => r.model).sort()).toEqual(["Unknown model", "my-alias", "my-combo"]);
  });
});

describe("settings validation", () => {
  it("accepts booleans and key id lists only", () => {
    expect(cv.validateCustomerViewPatch({ customerViewEnabled: true }).value).toEqual({ customerViewEnabled: true });
    expect(cv.validateCustomerViewPatch({ customerViewEnabled: "yes" }).error).toBeTruthy();
    expect(cv.validateCustomerViewPatch({ customerViewBlockedKeys: ["a", "a"] }).value).toEqual({
      customerViewBlockedKeys: ["a"],
    });
    expect(cv.validateCustomerViewPatch({ customerViewBlockedKeys: [1] }).error).toBeTruthy();
    expect(cv.validateCustomerViewPatch({ theme: "x" }).value).toEqual({});
  });
});
