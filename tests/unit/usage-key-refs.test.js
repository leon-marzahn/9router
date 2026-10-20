// Migration 005: usage rows store key references ("id:<keyId>" / "key-<hash>"), never raw
// API keys. Backfill of usageHistory and usageDaily.data on a fixture DB written the old
// way, idempotence, the boot-time heal after a downgrade, and per-key totals from every
// reader (stats, billing, budgets, customer view, history) before vs after.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
let db;
let adapter;
let refs;
let m005;
let keyA;
let keyB;
let deleted;
const UNKNOWN = "sk-unknown-never-issued-0000";
const NOW = new Date("2026-03-20T12:00:00.000Z");

const DAY1 = "2026-03-05";
const DAY2 = "2026-03-06";

// One usage row, as the pre-005 writer stored it: raw key in usageHistory.apiKey and
// a byApiKey bucket keyed by the raw key in that day's usageDaily JSON.
function legacyRow(rawKey, { day, model = "m1", cost = 1, charge = cost, tokens = 100 }) {
  adapter.run(
    "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, charge, status, tokens, meta) VALUES(?, 'p', ?, ?, ?, 10, ?, ?, 'ok', '{}', '{}')",
    [`${day}T10:00:00.000Z`, model, rawKey, tokens, cost, charge],
  );
  const row = adapter.get("SELECT data FROM usageDaily WHERE dateKey = ?", [day]);
  const data = row ? JSON.parse(row.data) : { requests: 0, byApiKey: {} };
  const bucketId = `${rawKey ?? "local-no-key"}|${model}|p`;
  const b = (data.byApiKey[bucketId] ??= {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
    charge: 0,
    credits: 0,
    creditCost: 0,
    rawModel: model,
    provider: "p",
    apiKey: rawKey ?? null,
  });
  b.requests += 1;
  b.promptTokens += tokens;
  b.completionTokens += 10;
  b.cost += cost;
  b.charge += charge;
  data.requests += 1;
  adapter.run(
    "INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data",
    [day, JSON.stringify(data)],
  );
}

function dump() {
  return JSON.stringify({
    h: adapter.all("SELECT * FROM usageHistory ORDER BY id"),
    d: adapter.all("SELECT * FROM usageDaily ORDER BY dateKey"),
  });
}

/** Per-key totals straight from usageHistory, grouped by whatever is in apiKey. */
function totalsByStoredKey() {
  const out = {};
  for (const r of adapter.all(
    "SELECT apiKey, COUNT(*) AS requests, SUM(cost) AS cost, SUM(charge) AS charge, SUM(promptTokens) AS prompt FROM usageHistory GROUP BY apiKey",
  ))
    out[r.apiKey ?? "none"] = {
      requests: r.requests,
      cost: r.cost,
      charge: r.charge,
      prompt: r.prompt,
    };
  return out;
}

/** Per-key totals from the byApiKey buckets of every day. */
function dailyTotals(keyOf) {
  const out = {};
  for (const r of adapter.all("SELECT data FROM usageDaily")) {
    for (const [id, b] of Object.entries(JSON.parse(r.data).byApiKey || {})) {
      const k = keyOf(id, b);
      const t = (out[k] ??= { requests: 0, cost: 0, charge: 0 });
      t.requests += b.requests;
      t.cost += b.cost;
      t.charge += b.charge;
    }
  }
  return out;
}

let before;
let beforeDaily;
let deletedRaw;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-keyrefs-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  refs = await import("@/lib/db/helpers/usageKeyRef.js");
  m005 = (await import("@/lib/db/migrations/005-usage-key-refs.js")).default;
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keyA = await db.createApiKey("acme", "machine-fixture");
  keyB = await db.createApiKey("globex", "machine-fixture");
  deleted = await db.createApiKey("gone", "machine-fixture");
  deletedRaw = deleted.key;

  // Fixture: a DB at schema 4 holding raw keys everywhere.
  adapter.run("UPDATE _meta SET value = '4' WHERE key = 'schemaVersion'");
  legacyRow(keyA.key, { day: DAY1, cost: 1, charge: 2 });
  legacyRow(keyA.key, { day: DAY1, cost: 2, charge: 3 });
  legacyRow(keyA.key, { day: DAY2, model: "m2", cost: 0.5, charge: 0.5 });
  legacyRow(` ${keyA.key} `, { day: DAY2, model: "m2", cost: 1, charge: 1 }); // untrimmed variant
  legacyRow(keyB.key, { day: DAY1, cost: 4, charge: 8 });
  legacyRow(deletedRaw, { day: DAY1, cost: 3, charge: 3 });
  legacyRow(UNKNOWN, { day: DAY2, cost: 5, charge: 5 });
  legacyRow(null, { day: DAY2, cost: 7, charge: 7 });
  await db.deleteApiKey(deleted.id);

  before = totalsByStoredKey();
  beforeDaily = dailyTotals((id, b) => (b.apiKey ?? "none").trim());
  // Sanity: the fixture really has raw keys in it.
  expect(dump()).toContain(keyA.key);
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._regentBudgetState;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sum = (...ts) =>
  ts
    .filter(Boolean)
    .reduce(
      (a, t) => ({
        requests: a.requests + t.requests,
        cost: a.cost + t.cost,
        charge: a.charge + t.charge,
      }),
      { requests: 0, cost: 0, charge: 0 },
    );

describe("migration 005", () => {
  it("replaces every raw key in usageHistory and usageDaily with a reference", () => {
    adapter.transaction(() => m005.up(adapter));
    const all = dump();
    for (const raw of [keyA.key, keyB.key, deletedRaw, UNKNOWN]) expect(all).not.toContain(raw);
    // No raw-key field left in the daily JSON buckets either.
    expect(JSON.stringify(adapter.all("SELECT data FROM usageDaily"))).not.toContain(
      '\\"apiKey\\"',
    );

    const after = totalsByStoredKey();
    const refA = `id:${keyA.id}`;
    expect(after[refA]).toEqual({
      requests: 4,
      cost: before[keyA.key].cost + before[` ${keyA.key} `].cost,
      charge: before[keyA.key].charge + before[` ${keyA.key} `].charge,
      prompt: 400,
    });
    expect(after[`id:${keyB.id}`]).toEqual(before[keyB.key]);
    // Deleted and unknown keys: stable non-secret hash, history still aggregates.
    expect(after[refs.hashedKeyRef(deletedRaw)]).toEqual(before[deletedRaw]);
    expect(after[refs.hashedKeyRef(UNKNOWN)]).toEqual(before[UNKNOWN]);
    expect(after.none).toEqual(before.none);
    expect(Object.keys(after)).toHaveLength(5);
  });

  it("re-keys the daily buckets with the same per-key totals", () => {
    const afterDaily = dailyTotals((id, b) => b.keyRef ?? "none");
    expect(afterDaily[`id:${keyA.id}`]).toEqual(beforeDaily[keyA.key]);
    expect(afterDaily[`id:${keyB.id}`]).toEqual(beforeDaily[keyB.key]);
    expect(afterDaily[refs.hashedKeyRef(deletedRaw)]).toEqual(beforeDaily[deletedRaw]);
    expect(afterDaily[refs.hashedKeyRef(UNKNOWN)]).toEqual(beforeDaily[UNKNOWN]);
    expect(afterDaily.none).toEqual(beforeDaily.none);
    // The untrimmed variant merged into keyA's bucket for the same model.
    const day2 = JSON.parse(
      adapter.get("SELECT data FROM usageDaily WHERE dateKey = ?", [DAY2]).data,
    );
    expect(day2.byApiKey[`id:${keyA.id}|m2|p`].requests).toBe(2);
    expect(day2.byApiKey["local-no-key|m1|p"].requests).toBe(1);
  });

  it("is idempotent: a second run changes nothing", () => {
    const snapshot = dump();
    let result;
    adapter.transaction(() => {
      result = refs.backfillUsageKeyRefs(adapter);
    });
    expect(result).toEqual({ history: 0, daily: 0 });
    adapter.transaction(() => m005.up(adapter));
    expect(dump()).toBe(snapshot);
    expect(refs.hasRawUsageKeys(adapter)).toBe(false);
  });

  it("keeps a deleted key's id reference stable (not re-hashed) after the key is gone", async () => {
    const tmp = await db.createApiKey("temp", "machine-fixture");
    await db.saveRequestUsage({
      provider: "p",
      model: "m9",
      apiKey: tmp.key,
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await db.deleteApiKey(tmp.id);
    const snapshot = dump();
    adapter.transaction(() => refs.backfillUsageKeyRefs(adapter));
    expect(dump()).toBe(snapshot);
    expect(snapshot).toContain(`id:${tmp.id}`);
    adapter.run("DELETE FROM usageHistory WHERE model = 'm9'");
  });
});

describe("readers after the migration", () => {
  it("usage stats: per-key totals by key id, deleted/unknown keys labelled, no key strings", async () => {
    const stats = await db.getUsageStats("all");
    const json = JSON.stringify(stats);
    for (const raw of [keyA.key, keyB.key, deletedRaw, UNKNOWN]) expect(json).not.toContain(raw);
    const byKey = {};
    for (const b of Object.values(stats.byApiKey)) {
      const k = b.keyId ?? b.keyName;
      byKey[k] = sum(byKey[k], b);
    }
    expect(byKey[keyA.id]).toEqual(beforeDaily[keyA.key]);
    expect(byKey[keyB.id]).toEqual(beforeDaily[keyB.key]);
    const deletedLabel = `Deleted key (${refs.hashedKeyRef(deletedRaw).slice(4, 12)})`;
    expect(byKey[deletedLabel]).toEqual(beforeDaily[deletedRaw]);
    expect(byKey["Local (No API Key)"]).toEqual(beforeDaily.none);
    const a = Object.values(stats.byApiKey).find((b) => b.keyId === keyA.id);
    expect(a.keyName).toBe("acme");
    expect(a.apiKeyMasked).toMatch(/\*\*\*/);
  });

  it("usage history: describes the key by id and masked current key", async () => {
    const rows = await db.getUsageHistory();
    expect(JSON.stringify(rows)).not.toContain(keyA.key);
    expect(rows.filter((r) => r.keyId === keyA.id)).toHaveLength(4);
    expect(rows.find((r) => r.keyName?.startsWith("Deleted key"))).toBeTruthy();
  });

  it("billing, budgets and the customer view see the same per-key totals", async () => {
    const billing = await import("@/lib/billing/index.js");
    const spend = await billing.getKeySpend(keyA.id);
    expect(spend.requests).toBe(4);
    expect(spend.cost).toBeCloseTo(before[keyA.key].cost + before[` ${keyA.key} `].cost);
    expect(spend.charge).toBeCloseTo(before[keyA.key].charge + before[` ${keyA.key} `].charge);

    const budgets = await import("@/lib/budgets/index.js");
    const budget = budgets.validateBudget(
      { spendLimit: 100, period: "month" },
      { isKey: true },
    ).value;
    const st = await budgets.budgetStatus(budgets.keyScope(keyB.id), budget, { now: NOW });
    expect(st.requests).toBe(1);
    expect(st.charge).toBe(8);
    expect(st.spend).toBe(8);

    const cv = await import("@/lib/customerView/index.js");
    const view = await cv.getCustomerUsage(await db.getApiKeyById(keyA.id), { now: NOW });
    expect(JSON.stringify(view)).not.toContain(keyA.key);
    expect(view.period.requests).toBe(4);
    expect(view.period.spend).toBeCloseTo(before[keyA.key].charge + before[` ${keyA.key} `].charge);
    expect(view.recent).toHaveLength(4);
  });

  it("budgets count new usage against the key's reference", async () => {
    const budgets = await import("@/lib/budgets/index.js");
    const repo = await import("@/lib/db/repos/budgetsRepo.js");
    const scope = budgets.keyScope(keyB.id);
    await repo.setBudget(
      scope,
      budgets.validateBudget({ requestLimit: 2, hardStop: true }, { isKey: true }).value,
    );
    budgets.invalidateBudgetCache({ counters: true });
    const now = new Date();
    expect(await budgets.checkBudget(keyB.key, { now })).toBeNull();
    await db.saveRequestUsage({
      provider: "p",
      model: "m1",
      apiKey: keyB.key,
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await db.saveRequestUsage({
      provider: "p",
      model: "m1",
      apiKey: keyB.key,
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });
    budgets.invalidateBudgetCache({ counters: true });
    expect(await budgets.checkBudget(keyB.key, { now })).toMatchObject({ scope });
    await repo.deleteBudget(scope);
    budgets.invalidateBudgetCache({ counters: true });
  });
});

describe("writer", () => {
  it("stores the reference for known and unknown keys, never the key string", async () => {
    await db.saveRequestUsage({
      provider: "p",
      model: "w1",
      apiKey: keyA.key,
      tokens: { prompt_tokens: 3, completion_tokens: 1 },
    });
    await db.saveRequestUsage({
      provider: "p",
      model: "w1",
      apiKey: "sk-stranger-1",
      tokens: { prompt_tokens: 3, completion_tokens: 1 },
    });
    const rows = adapter.all("SELECT apiKey FROM usageHistory WHERE model = 'w1' ORDER BY id");
    expect(rows.map((r) => r.apiKey)).toEqual([
      `id:${keyA.id}`,
      refs.hashedKeyRef("sk-stranger-1"),
    ]);
    const all = dump();
    expect(all).not.toContain(keyA.key);
    expect(all).not.toContain("sk-stranger-1");
  });
});

describe("downgrade then upgrade", () => {
  it("raw keys written by an older version are converted on the next boot", async () => {
    // What an older build writes into the migrated DB.
    legacyRow(keyA.key, { day: "2026-03-07", cost: 1, charge: 1 });
    expect(refs.hasRawUsageKeys(adapter)).toBe(true);
    try {
      global._dbAdapter?.instance?.close?.();
    } catch {}
    delete global._dbAdapter;
    vi.resetModules();
    adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const r = await import("@/lib/db/helpers/usageKeyRef.js");
    expect(r.hasRawUsageKeys(adapter)).toBe(false);
    expect(dump()).not.toContain(keyA.key);
    expect(
      adapter.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [`id:${keyA.id}`]).c,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe("refs", () => {
  it("are recognised and resolved", () => {
    expect(refs.isKeyRef("id:abc")).toBe(true);
    expect(refs.isKeyRef("id:")).toBe(false);
    expect(refs.isKeyRef(refs.hashedKeyRef("x"))).toBe(true);
    expect(refs.isKeyRef("sk-abc")).toBe(false);
    expect(refs.keyIdFromRef("id:abc")).toBe("abc");
    expect(refs.keyIdFromRef(refs.hashedKeyRef("x"))).toBeNull();
    expect(refs.usageKeyRef(adapter, "   ")).toBeNull();
    expect(refs.usageKeyRef(adapter, undefined)).toBeNull();
  });
});
