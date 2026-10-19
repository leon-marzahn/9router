// Per-key pricing (src/lib/billing): charge math (markup, minimum fee, custom rates,
// fallback, unpriced models), the charge fixed at write time, budgets on charge vs cost,
// getKeySpend, the dashboard routes (validation, no key strings), backup round trip,
// and migration 004 on a fresh and an existing DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/notify/index.js", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let billing;
let plansRepo;
let budgets;
let budgetsRepo;
let adapter;
let keyA;
let keyB;

const P = "zzbill"; // fake provider, priced below
const TOK_1M_IN = { prompt_tokens: 1_000_000, completion_tokens: 0 };

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-billing-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  delete global._regentBillingState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  billing = await import("@/lib/billing/index.js");
  plansRepo = await import("@/lib/db/repos/pricePlansRepo.js");
  budgets = await import("@/lib/budgets/index.js");
  budgetsRepo = await import("@/lib/db/repos/budgetsRepo.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keyA = await db.createApiKey("acme", "machine-fixture");
  keyB = await db.createApiKey("globex", "machine-fixture");
  // $1 / 1M input, $2 / 1M output, $0.5 / 1M cached
  await db.updatePricing({ [P]: { m1: { input: 1, output: 2, cached: 0.5 } } });
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._regentBudgetState;
  delete global._regentBillingState;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM pricePlans");
  adapter.run("DELETE FROM apiKeyPlans");
  adapter.run("DELETE FROM budgets");
  adapter.run("DELETE FROM budgetAlerts");
  billing.invalidateBillingCache();
  budgets.invalidateBudgetCache({ counters: true });
});

async function plan(id, input) {
  const { value, error } = billing.validatePlan({ name: id, ...input });
  if (error) throw new Error(error);
  await plansRepo.setPricePlan(id, value);
  billing.invalidateBillingCache();
  return value;
}

async function assign(key, planId) {
  await plansRepo.setKeyPlanId(key.id, planId);
  billing.invalidateBillingCache();
}

const rows = () => adapter.all("SELECT apiKey, model, cost, charge FROM usageHistory ORDER BY id");
const close = (a, b) => expect(a).toBeCloseTo(b, 9);

describe("computeCharge", () => {
  const entry = (cost, extra = {}) => ({
    cost,
    provider: P,
    model: "m1",
    tokens: { prompt_tokens: 10, completion_tokens: 10 },
    ...extra,
  });

  it("passes cost through on the default (unedited) plan", () => {
    expect(billing.computeCharge(entry(0.25))).toBe(0.25);
  });

  it("applies a percentage markup", () => {
    close(billing.computeCharge(entry(1), { markupPercent: 50, rates: [] }), 1.5);
  });

  it("raises small requests to the minimum fee, but never charges an empty failed request", () => {
    const p = { markupPercent: 20, minFee: 0.01, rates: [] };
    close(billing.computeCharge(entry(0.001), p), 0.01);
    close(billing.computeCharge(entry(1), p), 1.2);
    const empty = entry(0, { tokens: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(billing.computeCharge(empty, p)).toBe(0);
  });

  it("uses a custom per-model rate instead of cost (provider/model before bare model)", () => {
    const p = {
      markupPercent: 100,
      rates: [
        { model: "m1", input: 9, output: 9, cached: null },
        { model: `OpenAI/M1`, input: 3, output: 6, cached: 1 },
      ],
    };
    // 1M input at $3, nothing else. Cost is irrelevant once a rate matches.
    close(
      billing.computeCharge({ cost: 1, provider: "openai", model: "m1", tokens: TOK_1M_IN }, p),
      3,
    );
    // Same model via another provider: the bare-model rate.
    close(
      billing.computeCharge({ cost: 1, provider: "other", model: "m1", tokens: TOK_1M_IN }, p),
      9,
    );
    // Cached input at the cached rate (falls back to input when unset).
    const cached = { prompt_tokens: 1_000_000, cached_tokens: 1_000_000 };
    close(
      billing.computeCharge({ cost: 0, provider: "openai", model: "m1", tokens: cached }, p),
      1,
    );
    close(billing.computeCharge({ cost: 0, provider: "x", model: "m1", tokens: cached }, p), 9);
  });

  it("charges reasoning tokens once, inside completion, at a custom rate", () => {
    const p = { markupPercent: 0, rates: [{ model: "m1", input: 0, output: 2 }] };
    const tokens = { prompt_tokens: 0, completion_tokens: 1_000_000, reasoning_tokens: 400_000 };
    close(billing.computeCharge({ cost: 0, provider: "x", model: "m1", tokens }, p), 2);
  });

  it("falls back to the markup for models without a custom rate", () => {
    const p = { markupPercent: 10, rates: [{ model: "other", input: 5, output: 5 }] };
    close(billing.computeCharge(entry(2), p), 2.2);
  });

  it("charges an unpriced model nothing on markup, the minimum fee if set, or its custom rate", () => {
    const unpriced = { cost: 0, provider: P, model: "nopricing", tokens: TOK_1M_IN };
    expect(billing.computeCharge(unpriced, { markupPercent: 300, rates: [] })).toBe(0);
    close(billing.computeCharge(unpriced, { markupPercent: 300, minFee: 0.05, rates: [] }), 0.05);
    const rated = { markupPercent: 0, rates: [{ model: "nopricing", input: 2, output: 2 }] };
    close(billing.computeCharge(unpriced, rated), 2);
  });
});

describe("rate prefixes resolve the way clients route", () => {
  const NODE = "openai-compatible-chat-1234";
  const nodes = { real: NODE };
  const req = (provider, model) => ({ cost: 1, provider, model, tokens: TOK_1M_IN });

  it("matches a compatible node by its prefix, not its internal id", () => {
    const p = { markupPercent: 0, rates: [{ model: "real/fake-1", input: 7, output: 7 }] };
    close(billing.computeCharge(req(NODE, "fake-1"), p, nodes), 7);
    // Without the node map (or for another provider) the prefixed rate doesn't apply.
    close(billing.computeCharge(req(NODE, "fake-1"), p, {}), 1);
    close(billing.computeCharge(req("openai", "fake-1"), p, nodes), 1);
  });

  it("matches a provider alias (cc -> claude) and a plain provider id", () => {
    expect(billing.resolveRatePrefix("cc")).toBe("claude");
    expect(billing.resolveRatePrefix("openai")).toBe("openai");
    const p = {
      markupPercent: 0,
      rates: [
        { model: "cc/sonnet", input: 4, output: 4 },
        { model: "openai/gpt-x", input: 5, output: 5 },
      ],
    };
    close(billing.computeCharge(req("claude", "sonnet"), p), 4);
    close(billing.computeCharge(req("openai", "gpt-x"), p), 5);
  });

  it("treats an unknown prefix as a bare model id (OpenRouter style), and prefixed beats bare", () => {
    expect(billing.resolveRatePrefix("nosuchprefix")).toBeNull();
    const p = {
      markupPercent: 0,
      rates: [
        { model: "nosuchprefix/m", input: 3, output: 3 },
        { model: "fake-1", input: 2, output: 2 },
        { model: "real/fake-1", input: 9, output: 9 },
      ],
    };
    close(billing.computeCharge(req("openrouter", "nosuchprefix/m"), p, nodes), 3);
    close(billing.computeCharge(req(NODE, "fake-1"), p, nodes), 9); // prefixed wins, though listed later
    close(billing.computeCharge(req("other", "fake-1"), p, nodes), 2); // bare for any other provider
  });

  it("records the node-prefixed rate end to end and lists how rates resolve", async () => {
    const node = await db.createProviderNode({
      type: "openai-compatible",
      name: "Real upstream",
      prefix: "real",
      apiType: "chat",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    await plan("plan_node", {
      rates: [
        { model: "real/fake-1", input: 3, output: 0 },
        { model: "fake-2", input: 1, output: 1 },
      ],
    });
    await assign(keyA, "plan_node");
    await db.saveRequestUsage({
      provider: node.id,
      model: "fake-1",
      apiKey: keyA.key,
      tokens: TOK_1M_IN,
    });
    close(rows()[0].charge, 3);
    const { resolved } = await billing.listPlans();
    expect(resolved["real/fake-1"]).toBe("Real upstream");
    expect(resolved["fake-2"]).toBeNull();
  });
});

describe("validatePlan", () => {
  it("accepts a sane plan and rejects nonsense", () => {
    const ok = billing.validatePlan({
      name: " Pro\n",
      markupPercent: "25",
      minFee: "0",
      rates: [{ model: "openai/gpt-x", input: "1.5", output: 6 }],
    });
    expect(ok.value).toEqual({
      name: "Pro",
      markupPercent: 25,
      minFee: null,
      rates: [{ model: "openai/gpt-x", input: 1.5, output: 6, cached: null }],
    });
    expect(billing.validatePlan({ name: "" }).error).toBeTruthy();
    expect(billing.validatePlan({ name: "x", markupPercent: -1 }).error).toBeTruthy();
    expect(billing.validatePlan({ name: "x", markupPercent: "abc" }).error).toBeTruthy();
    expect(billing.validatePlan({ name: "x", minFee: -0.1 }).error).toBeTruthy();
    expect(
      billing.validatePlan({ name: "x", rates: [{ model: "a b", input: 1, output: 1 }] }).error,
    ).toBeTruthy();
    expect(
      billing.validatePlan({ name: "x", rates: [{ model: "a", input: 1 }] }).error,
    ).toBeTruthy();
    expect(
      billing.validatePlan({
        name: "x",
        rates: [
          { model: "A", input: 1, output: 1 },
          { model: "a", input: 1, output: 1 },
        ],
      }).error,
    ).toMatch(/twice/);
  });
});

describe("charge recorded at write time", () => {
  const save = (apiKey) =>
    db.saveRequestUsage({
      provider: P,
      model: "m1",
      apiKey,
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    });

  it("stores cost and the key's charge; editing the plan doesn't rewrite history", async () => {
    await plan("plan_pro", { markupPercent: 100 });
    await assign(keyA, "plan_pro");
    await save(keyA.key); // cost $1 + $1 = $2 → charge $4
    await plan("plan_pro", { markupPercent: 0 });
    await save(keyA.key); // now charge = cost
    const [first, second] = rows();
    close(first.cost, 2);
    close(first.charge, 4);
    close(second.charge, 2);
  });

  it("uses the default plan for keys without one, and charge = cost without a key", async () => {
    await plan(billing.DEFAULT_PLAN_ID, { markupPercent: 50 });
    await save(keyB.key);
    await save(null);
    const [keyed, local] = rows();
    close(keyed.charge, 3);
    close(local.charge, local.cost);
  });

  it("falls back to cost when the plan lookup breaks", async () => {
    await plan(billing.DEFAULT_PLAN_ID, { markupPercent: 50 });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    adapter.exec("ALTER TABLE apiKeyPlans RENAME TO apiKeyPlans_off");
    try {
      await save(keyA.key);
    } finally {
      adapter.exec("ALTER TABLE apiKeyPlans_off RENAME TO apiKeyPlans");
      spy.mockRestore();
    }
    const [r] = rows();
    close(r.charge, r.cost);
  });

  it("rolls charge into usage stats per key", async () => {
    await plan("plan_pro", { markupPercent: 100 });
    await assign(keyA, "plan_pro");
    await save(keyA.key);
    const stats = await db.getUsageStats("24h");
    const bucket = Object.values(stats.byApiKey).find((b) => b.keyId === keyA.id);
    close(bucket.cost, 2);
    close(bucket.charge, 4);
    expect(JSON.stringify(stats)).not.toContain(keyA.key);
  });
});

describe("getKeySpend", () => {
  it("totals cost, charge, tokens and requests with a per-model breakdown", async () => {
    const at = (iso, model, cost, charge) =>
      adapter.run(
        "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, charge, status) VALUES(?, ?, ?, ?, 100, 50, ?, ?, 'ok')",
        [iso, P, model, keyA.key, cost, charge],
      );
    at("2026-10-01T00:00:00.000Z", "m1", 1, 2);
    at("2026-10-02T00:00:00.000Z", "m1", 1, 2);
    at("2026-10-03T00:00:00.000Z", "m2", 0.5, null); // pre-pricing row: charge = cost
    at("2026-11-01T00:00:00.000Z", "m1", 9, 9); // outside the range

    const s = await billing.getKeySpend(keyA.id, {
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z",
    });
    expect(s).toMatchObject({ requests: 3, tokens: 450, promptTokens: 300, completionTokens: 150 });
    close(s.cost, 2.5);
    close(s.charge, 4.5);
    close(s.margin, 2);
    expect(s.byModel.map((m) => [m.model, m.requests, m.charge])).toEqual([
      ["m1", 2, 4],
      ["m2", 1, 0.5],
    ]);
    expect(JSON.stringify(s)).not.toContain(keyA.key);
    expect(await billing.getKeySpend("nope")).toBeNull();
    expect((await billing.getKeySpend(keyB.id)).requests).toBe(0);
  });
});

describe("budgets enforce on charge for keys, cost globally", () => {
  const NOW = new Date();
  const row = (apiKey, cost, charge) =>
    adapter.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, charge, status) VALUES(?, ?, 'm1', ?, 10, 0, ?, ?, 'ok')",
      [NOW.toISOString(), P, apiKey, cost, charge],
    );
  async function setBudget(scope, input) {
    const { value } = budgets.validateBudget(input, { isKey: scope !== "global" });
    await budgetsRepo.setBudget(scope, value);
    budgets.invalidateBudgetCache({ counters: true });
    return value;
  }

  it("blocks a key whose charge reaches its limit even though cost is under it", async () => {
    row(keyA.key, 0.6, 1.2);
    await setBudget(budgetsRepo.keyScope(keyA.id), { spendLimit: 1, hardStop: true });
    expect(await budgets.checkBudget(keyA.key)).toMatchObject({ global: false });
  });

  it("measures the global budget on upstream cost", async () => {
    row(keyA.key, 0.6, 1.2);
    await setBudget("global", { spendLimit: 1, hardStop: true });
    expect(await budgets.checkBudget(keyA.key)).toBeNull();
    row(keyB.key, 0.5, 5);
    budgets.invalidateBudgetCache({ counters: true });
    expect(await budgets.checkBudget(keyA.key)).toMatchObject({ global: true });
  });

  it("budgetStatus reports cost, charge and which one the limit uses", async () => {
    row(keyA.key, 0.6, 1.2);
    const scope = budgetsRepo.keyScope(keyA.id);
    const b = await setBudget(scope, { spendLimit: 2 });
    const s = await budgets.budgetStatus(scope, b, keyA.key);
    expect(s.spendBasis).toBe("charge");
    close(s.cost, 0.6);
    close(s.charge, 1.2);
    close(s.spend, 1.2);
    close(s.ratio, 0.6);
    const g = await setBudget("global", { spendLimit: 2 });
    const gs = await budgets.budgetStatus("global", g, null);
    expect(gs.spendBasis).toBe("cost");
    close(gs.spend, 0.6);
  });

  it("recordUsage bumps a key's cached counter by charge", async () => {
    const scope = budgetsRepo.keyScope(keyA.id);
    await setBudget(scope, { spendLimit: 1, hardStop: true });
    expect(await budgets.checkBudget(keyA.key)).toBeNull(); // seeds the counter at 0
    row(keyA.key, 0.3, 1.5); // in the table, but the counter is cached
    await budgets.recordUsage({ apiKey: keyA.key, cost: 0.3, charge: 1.5, tokens: {} });
    expect(await budgets.checkBudget(keyA.key)).toMatchObject({ global: false });
  });
});

describe("dashboard routes", () => {
  const req = (body) =>
    new Request("http://localhost/api/pricing/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id) => ({ params: Promise.resolve({ id }) });

  it("creates, edits, assigns and deletes plans without ever returning key strings", async () => {
    const list = await import("@/app/api/pricing/plans/route.js");
    const one = await import("@/app/api/pricing/plans/[id]/route.js");
    const keyPlan = await import("@/app/api/keys/[id]/plan/route.js");

    expect((await list.POST(req({ name: "" }))).status).toBe(400);
    const created = await list.POST(req({ name: "Pro", markupPercent: 40 }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(id).toMatch(billing.PLAN_ID_RE);

    expect((await one.PUT(req({ name: "Pro", markupPercent: 30 }), ctx(id))).status).toBe(200);
    expect((await one.PUT(req({ name: "X" }), ctx("plan_missing"))).status).toBe(404);
    expect((await one.PUT(req({ name: "X" }), ctx("../etc"))).status).toBe(404);
    expect((await one.PUT(req({ name: "Base", markupPercent: 5 }), ctx("default"))).status).toBe(
      200,
    );

    expect((await keyPlan.PUT(req({ planId: id }), ctx("nope"))).status).toBe(404);
    expect((await keyPlan.PUT(req({ planId: "plan_missing" }), ctx(keyA.id))).status).toBe(404);
    expect((await keyPlan.PUT(req({ planId: 5 }), ctx(keyA.id))).status).toBe(400);
    expect((await keyPlan.PUT(req({ planId: id }), ctx(keyA.id))).status).toBe(200);

    const text = await (await list.GET()).text();
    expect(text).not.toContain(keyA.key);
    expect(text).not.toContain(keyB.key);
    const body = JSON.parse(text);
    expect(body.plans[id].markupPercent).toBe(30);
    expect(body.plans.default.markupPercent).toBe(5);
    expect(body.keyPlans).toEqual({ [keyA.id]: id });

    // Deleting a plan moves its keys to the default plan.
    expect((await one.DELETE(req(), ctx(id))).status).toBe(200);
    expect(JSON.parse(await (await list.GET()).text()).keyPlans).toEqual({});
  });

  it("deleting a key drops its plan assignment; plans survive a backup round trip", async () => {
    const k = await db.createApiKey("temp", "machine-fixture");
    await plan("plan_a", { markupPercent: 10, rates: [{ model: "m1", input: 1, output: 2 }] });
    await assign(k, "plan_a");
    await assign(keyB, "plan_a");
    const dump = await db.exportDb();
    expect(dump.pricePlans).toHaveLength(1);
    expect(dump.keyPlans).toHaveLength(2);
    await db.importDb(dump);
    expect(Object.keys(await plansRepo.getPricePlans())).toEqual(["plan_a"]);
    expect(await plansRepo.getKeyPlanIds()).toEqual({ [k.id]: "plan_a", [keyB.id]: "plan_a" });

    // Assignments for keys missing from the backup are dropped.
    await db.importDb({
      ...dump,
      keyPlans: [...dump.keyPlans, { keyId: "ghost", planId: "plan_a" }],
    });
    expect(Object.keys(await plansRepo.getKeyPlanIds())).not.toContain("ghost");

    await db.importDb({ ...dump, pricePlans: [{ id: "bad id", name: "x" }] }).then(
      () => {
        throw new Error("should refuse");
      },
      (e) => expect(e.message).toMatch(/pricePlans/),
    );

    await db.deleteApiKey(k.id);
    expect(await plansRepo.getKeyPlanIds()).toEqual({ [keyB.id]: "plan_a" });
  });
});

describe("migration 004", () => {
  it("creates the tables and charge column on a fresh DB", () => {
    const tables = adapter
      .all("SELECT name FROM sqlite_master WHERE type='table'")
      .map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["pricePlans", "apiKeyPlans"]));
    const cols = adapter.all("PRAGMA table_info(usageHistory)").map((c) => c.name);
    expect(cols).toContain("charge");
  });

  it("backfills charge = cost on an existing DB", () => {
    const m004 = (async () => (await import("@/lib/db/migrations/004-key-pricing.js")).default)();
    return m004.then((m) => {
      adapter.exec("ALTER TABLE usageHistory DROP COLUMN charge");
      adapter.run(
        "INSERT INTO usageHistory(timestamp, provider, model, cost, status) VALUES('2026-01-01T00:00:00Z', 'p', 'm', 1.25, 'ok')",
      );
      adapter.run(
        "INSERT INTO usageHistory(timestamp, provider, model, cost, status) VALUES('2026-01-01T00:00:00Z', 'p', 'm', NULL, 'ok')",
      );
      adapter.transaction(() => m.up(adapter));
      expect(adapter.all("SELECT cost, charge FROM usageHistory ORDER BY id")).toEqual([
        { cost: 1.25, charge: 1.25 },
        { cost: null, charge: 0 },
      ]);
      // Idempotent: running again changes nothing.
      adapter.transaction(() => m.up(adapter));
      expect(adapter.all("SELECT charge FROM usageHistory ORDER BY id")).toEqual([
        { charge: 1.25 },
        { charge: 0 },
      ]);
    });
  });
});
