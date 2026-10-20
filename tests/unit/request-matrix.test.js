// Request-path contract: every combination of how a client asks (stream field,
// Accept header, wire format) against every way an upstream answers. Real /v1 route
// handlers, real DB (temp DATA_DIR), real translators, usage, billing and budgets;
// only the network is faked (proxyAwareFetch). The tables below are the spec.
//
// Born from a hand-built matrix that found requests omitting `stream` were never
// billed (#111): a regression in any cell here is a billing or protocol bug.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("@/lib/notify/index.js", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

// ---------- fake upstream ----------

const MODEL = "fake-model";
// Client-facing usage carries a context-safety buffer on prompt tokens (usageTracking.js);
// recorded/billed usage never does.
const CLIENT_PROMPT_BUFFER = 2000;
const USAGE = { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 };
const PRICE = { input: 2, output: 8 }; // USD per 1M tokens
const COST = (USAGE.prompt_tokens * PRICE.input + USAGE.completion_tokens * PRICE.output) / 1e6;
const MARKUP = 50; // percent, on the client key's plan
const CHARGE = COST * (1 + MARKUP / 100);
// Fields a strict upstream accepts; anything else (stream_options, …) is a 422.
const STRICT_FIELDS = new Set(["model", "messages", "stream", "max_tokens", "temperature", "top_p", "tools", "tool_choice", "stop", "n", "user"]);

const completion = () => ({
  id: "chatcmpl-fake",
  object: "chat.completion",
  created: 1700000000,
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: USAGE,
});

/** OpenAI chat SSE. Usage rides on a separate trailer chunk (include_usage style). */
function sseBody() {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1700000000, model: MODEL };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: USAGE },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sse = () => new Response(sseBody(), { headers: { "content-type": "text/event-stream" } });

const UPSTREAMS = {
  honors: (body) => (body.stream === true ? sse() : json(completion())),
  json: () => json(completion()),
  sse: () => sse(),
  strict: (body) => {
    const unknown = Object.keys(body).filter((k) => !STRICT_FIELDS.has(k));
    if (unknown.length) return json({ error: { message: `unknown fields: ${unknown.join(",")}` } }, 422);
    return body.stream === true ? sse() : json(completion());
  },
  down: () => json({ error: { message: "upstream unavailable" } }, 503),
};
const MODES = Object.keys(UPSTREAMS);

/** Upstream bodies seen, in order: { mode, body }. */
let calls = [];
function fakeFetch(url, init) {
  const mode = new URL(String(url)).hostname.split(".")[0];
  const body = JSON.parse(init.body);
  calls.push({ mode, body });
  return UPSTREAMS[mode](body);
}

// ---------- app under test ----------

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let adapter;
let budgets;
let routes;
let clientKey;
let db;
const connectionIds = [];
let budgetScope;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-matrix-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  delete global._regentBillingState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  const billing = await import("@/lib/billing/index.js");
  const plans = await import("@/lib/db/repos/pricePlansRepo.js");
  const budgetsRepo = await import("@/lib/db/repos/budgetsRepo.js");
  budgets = await import("@/lib/budgets/index.js");
  // Keep the 503 retry (one extra attempt) but without the real 2 s wait.
  const { DEFAULT_RETRY_CONFIG } = await import("open-sse/config/runtimeConfig.js");
  DEFAULT_RETRY_CONFIG[503] = { attempts: 1, delayMs: 0 };
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();

  // One OpenAI-compatible node per upstream mode; the base URL host picks the mode.
  const pricing = {};
  for (const mode of MODES) {
    const node = await db.createProviderNode({
      id: `openai-compatible-chat-${mode}`,
      type: "openai-compatible",
      name: `Fake ${mode}`,
      prefix: mode,
      apiType: "chat",
      baseUrl: `http://${mode}.upstream.test/v1`,
    });
    const conn = await db.createProviderConnection({
      provider: node.id,
      authType: "apikey",
      name: `${mode}-key`,
      apiKey: `sk-upstream-${mode}`,
      isActive: true,
      providerSpecificData: { prefix: mode, apiType: "chat", baseUrl: node.baseUrl, nodeName: node.name },
    });
    connectionIds.push(conn.id);
    pricing[node.id] = { [MODEL]: PRICE };
  }
  await db.updatePricing(pricing);
  await db.createCombo({ name: "fb-503", models: [`down/${MODEL}`, `honors/${MODEL}`] });
  await db.createCombo({ name: "fb-strict", models: [`strict/${MODEL}`, `honors/${MODEL}`] });

  const key = await db.createApiKey("matrix", "machine-fixture");
  clientKey = key.key;
  const { value } = billing.validatePlan({ name: "Markup", markupPercent: MARKUP });
  await plans.setPricePlan("markup", value);
  await plans.setKeyPlanId(key.id, "markup");
  budgetScope = budgetsRepo.keyScope(key.id);
  const budget = budgets.validateBudget({ enabled: true, period: "month", spendLimit: 1_000_000 });
  if (budget.error) throw new Error(budget.error);
  await budgetsRepo.setBudget(budgetScope, budget.value);
  billing.invalidateBillingCache();
  budgets.invalidateBudgetCache({ counters: true });

  routes = {
    openai: (await import("@/app/api/v1/chat/completions/route.js")).POST,
    claude: (await import("@/app/api/v1/messages/route.js")).POST,
    responses: (await import("@/app/api/v1/responses/route.js")).POST,
  };
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

beforeEach(async () => {
  // Undo the cooldown a 503 puts on an account, so cells stay independent.
  for (const id of connectionIds)
    await db.updateProviderConnection(id, { [`modelLock_${MODEL}`]: null, modelLock___all: null, testStatus: "active", lastError: null, errorCode: null, backoffLevel: 0 });
  calls = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(fakeFetch);
  adapter.run("DELETE FROM usageHistory");
});

const FORMATS = {
  openai: {
    path: "/v1/chat/completions",
    body: (model) => ({ model, messages: [{ role: "user", content: "hi" }] }),
    text: (j) => j.choices?.[0]?.message?.content,
    isJson: (j) => j.object === "chat.completion",
  },
  claude: {
    path: "/v1/messages",
    body: (model) => ({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    text: (j) => j.content?.find((b) => b.type === "text")?.text,
    isJson: (j) => j.type === "message",
  },
  responses: {
    path: "/v1/responses",
    body: (model) => ({ model, input: "hi" }),
    text: (j) => j.output?.flatMap((o) => o.content || []).find((c) => c.type === "output_text")?.text,
    isJson: (j) => j.object === "response",
  },
};

const counter = () => global._regentBudgetState?.counters.get(budgetScope);

async function send({ format, model, stream, accept, includeUsage }) {
  const f = FORMATS[format];
  const body = f.body(model);
  if (stream !== undefined) body.stream = stream;
  if (includeUsage) body.stream_options = { include_usage: true };
  const sent = structuredClone(body);
  const headers = { "content-type": "application/json", authorization: `Bearer ${clientKey}` };
  if (accept) headers.accept = accept;
  const before = { ...(counter() || { requests: 0, charge: 0 }) };
  const res = await routes[format](new Request(`http://localhost${f.path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text(); // drain: stream finalizers write usage
  // Usage and budget writes run off the request path; let them land.
  for (let i = 0; i < 50 && !adapter.get("SELECT 1 AS x FROM usageHistory"); i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 5));
  const rows = adapter.all("SELECT provider, model, apiKey, promptTokens, completionTokens, cost, charge FROM usageHistory");
  return { res, text, rows, sent, before, after: counter() };
}

const count = (text, needle) => text.split(needle).length - 1;
const check = expect.soft; // report every broken property of a cell, not just the first

/** One usage row with the upstream's real tokens, cost and the key's marked-up charge. */
function expectBilled({ rows, before, after }, provider) {
  check(rows, "usage rows").toHaveLength(1);
  const [row = {}] = rows;
  check(row.provider, "provider").toBe(`openai-compatible-chat-${provider}`);
  check(row.apiKey, "api key").toBe(clientKey);
  check(row.promptTokens, "prompt tokens (real, no buffer/estimate)").toBe(USAGE.prompt_tokens);
  check(row.completionTokens, "completion tokens").toBe(USAGE.completion_tokens);
  check(row.cost, "cost").toBeCloseTo(COST, 10);
  check(row.charge, "charge (markup plan)").toBeCloseTo(CHARGE, 10);
  check((after?.requests ?? 0) - (before.requests || 0), "budget requests").toBe(1);
  check((after?.charge ?? 0) - (before.charge || 0), "budget charge").toBeCloseTo(CHARGE, 10);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Response shape: SSE vs JSON as asked, in the client's own format, one terminator. */
function expectShape({ res, text }, { format, wantSSE, includeUsage }) {
  check(res.status, "status").toBe(200);
  if (!wantSSE) {
    check(res.headers.get("content-type"), "content-type").toContain("application/json");
    const j = parseJson(text) || {};
    check(FORMATS[format].isJson(j), `${format} JSON object`).toBe(true);
    check(FORMATS[format].text(j), "content").toBe("Hello");
    return;
  }
  check(res.headers.get("content-type"), "content-type").toContain("text/event-stream");
  check(text, "content").toContain("Hello");
  if (format === "openai") {
    check(count(text, "data: [DONE]"), "[DONE] count").toBe(1);
    check(text.trimEnd().endsWith("data: [DONE]"), "[DONE] is last").toBe(true);
    const chunks = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => parseJson(l.slice(6)) || {});
    // Usage is always folded into the finish chunk (buffered, see CLIENT_PROMPT_BUFFER);
    // the usage-only trailer chunk (choices: []) is for clients that asked for it.
    const finish = chunks.filter((c) => c.choices?.[0]?.finish_reason);
    const trailers = chunks.filter((c) => c.usage && !c.choices?.length);
    check(finish, "finish chunks").toHaveLength(1);
    check(finish[0]?.usage?.completion_tokens, "finish-chunk completion tokens").toBe(USAGE.completion_tokens);
    check(finish[0]?.usage?.prompt_tokens, "finish-chunk prompt tokens").toBe(USAGE.prompt_tokens + CLIENT_PROMPT_BUFFER);
    if (includeUsage) {
      check(trailers, "usage trailer (include_usage)").toHaveLength(1);
      check(trailers[0]?.usage?.completion_tokens, "trailer completion tokens").toBe(USAGE.completion_tokens);
      check([USAGE.prompt_tokens, USAGE.prompt_tokens + CLIENT_PROMPT_BUFFER], "trailer prompt tokens").toContain(trailers[0]?.usage?.prompt_tokens);
    } else {
      check(trailers, "usage trailer (not requested)").toHaveLength(0);
    }
  } else if (format === "claude") {
    check(count(text, "event: message_stop"), "message_stop count").toBe(1);
    check(count(text, "[DONE]"), "[DONE] count").toBe(0);
  } else {
    check(count(text, "event: response.completed"), "response.completed count").toBe(1);
    check(count(text, "[DONE]"), "[DONE] count").toBeLessThanOrEqual(1);
  }
}

/** A non-streaming client never makes the proxy stream upstream or add stream_options. */
function expectNoLeak({ sent }, { wantSSE }) {
  if (wantSSE || sent.stream_options) return;
  for (const { mode, body } of calls) {
    check(body.stream_options, `${mode} upstream stream_options`).toBeUndefined();
    check(body.stream === true, `${mode} upstream stream:true`).toBe(false);
  }
}

// ---------- the matrix ----------

const STREAMS = [undefined, true, false];
const ACCEPTS = [undefined, "application/json", "text/event-stream", "application/json, text/event-stream"];
/** Client wants SSE: stream:true, or stream omitted with an SSE-only Accept. */
const wantsSSE = (stream, accept) => stream === true || (stream === undefined && accept === "text/event-stream");

const cells = [];
for (const format of Object.keys(FORMATS))
  for (const mode of MODES)
    for (const stream of STREAMS)
      for (const accept of ACCEPTS)
        for (const includeUsage of format === "openai" && stream === true ? [false, true] : [false])
          cells.push({ format, mode, stream, accept, includeUsage, wantSSE: wantsSSE(stream, accept) });

const label = (c) =>
  `${c.format} | ${c.mode} | stream=${c.stream ?? "omitted"} | accept=${c.accept ?? "none"}${c.includeUsage ? " | include_usage" : ""}`;

/**
 * Cells that fail on master: real bugs. They run as it.fails, so the fix turns them
 * red here; then delete the entry.
 */
const KNOWN_BROKEN = [
  {
    // An always-JSON upstream replayed as SSE folds usage into the finish chunk but
    // never emits the usage-only trailer the client asked for with include_usage.
    match: /^openai \| json \| stream=true \| .* \| include_usage$/,
  },
  {
    // The strict upstream 422s the proxy's own stream_options; on the retry without it
    // the client's finish chunk carries an estimate instead of the real usage, and the
    // upstream's usage trailer reaches a client that didn't ask for it. (Billing is right.)
    match: /^(openai \| strict|fb-strict \| openai) \| (stream=true|stream=omitted \| accept=text\/event-stream)(?!.*include_usage)/,
  },
];
const isKnownBroken = (name) => KNOWN_BROKEN.some(({ match }) => match.test(name));

describe("request matrix", () => {
  for (const cell of cells) {
    const name = label(cell);
    (isKnownBroken(name) ? it.fails : it)(name, async () => {
      const r = await send({ ...cell, model: `${cell.mode}/${MODEL}` });
      if (cell.mode === "down") {
        // Retried once, then the upstream's 503 reaches the client; nothing billed.
        check(r.res.status, "status").toBe(503);
        check(calls.length, "attempts").toBe(2);
        check(r.rows.filter((row) => row.promptTokens || row.completionTokens || row.cost), "billed rows").toHaveLength(0);
        return;
      }
      if (cell.mode === "strict" && cell.includeUsage) {
        // The client's own stream_options is forwarded as sent; the strict upstream's 422 is the answer.
        check(r.res.status, "status").toBe(422);
        check(r.rows.filter((row) => row.cost), "billed rows").toHaveLength(0);
        return;
      }
      expectShape(r, cell);
      expectBilled(r, cell.mode);
      expectNoLeak(r, cell);
    });
  }
});

describe("combo fallback", () => {
  const FALLBACKS = [
    // 503 on the first model falls through to the next one.
    { combo: "fb-503", first: "down", served: "honors" },
    // The proxy's own stream_options is dropped on the strict upstream's 422 and retried there.
    { combo: "fb-strict", first: "strict", served: "strict" },
  ];
  const variants = [
    { stream: undefined },
    { stream: undefined, accept: "application/json" },
    { stream: undefined, accept: "text/event-stream" },
    { stream: true },
    { stream: true, includeUsage: true },
    { stream: false },
  ];
  for (const { combo, first, served } of FALLBACKS)
    for (const format of Object.keys(FORMATS))
      for (const v of variants) {
        if (v.includeUsage && (format !== "openai" || first === "strict")) continue;
        const cell = { format, ...v, wantSSE: wantsSSE(v.stream, v.accept) };
        const name = `${combo} | ${format} | stream=${v.stream ?? "omitted"} | accept=${v.accept ?? "none"}${v.includeUsage ? " | include_usage" : ""}`;
        (isKnownBroken(name) ? it.fails : it)(name, async () => {
          const r = await send({ ...cell, model: combo });
          check(calls[0]?.mode, "first target").toBe(first);
          check(calls.at(-1)?.mode, "served by").toBe(served);
          if (first === "down") {
            // Every attempt derives from the client's original body: no stream flag carried over.
            const flags = (b) => JSON.stringify([b.stream, b.stream_options]);
            check(flags(calls.at(-1).body), "fallback body stream flags").toBe(flags(calls[0].body));
          }
          expectShape(r, cell);
          expectBilled(r, served);
          expectNoLeak(r, cell);
        });
      }
});
