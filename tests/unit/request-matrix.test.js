// Request-path contract: every combination of how a client asks (stream field,
// Accept header, wire format) against every way an upstream answers. Real /v1 route
// handlers, real DB (temp DATA_DIR), real translators, usage, billing and budgets;
// only the network is faked (proxyAwareFetch). The tables below are the spec.
// Upstreams cover OpenAI-compatible chat nodes (honors stream, always JSON, always SSE,
// strict, 503), a forceStream provider (SSE aggregated to JSON) and a Responses-API node.
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

/** OpenAI Responses API object (what a Responses upstream returns). */
const responseObject = () => ({
  id: "resp_fake",
  object: "response",
  created_at: 1700000000,
  status: "completed",
  model: MODEL,
  output: [
    {
      type: "message",
      id: "msg_fake",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello", annotations: [] }],
    },
  ],
  usage: { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens, total_tokens: USAGE.total_tokens },
});

/** Responses API SSE, usage on response.completed. */
function responsesSseBody() {
  const done = responseObject();
  const item = done.output[0];
  /** @type {[string, object][]} */
  const events = [
    ["response.created", { response: { ...done, status: "in_progress", output: [], usage: null } }],
    ["response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
    ["response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
    ["response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "Hello" }],
    ["response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: "Hello" }],
    ["response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] }],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: done }],
  ];
  return events.map(([type, data], i) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: i, ...data })}\n\n`).join("");
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sse = (text = sseBody()) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const honors = (body) => (body.stream === true ? sse() : json(completion()));

/**
 * Upstream modes. Each is an OpenAI-compatible node (apiType chat unless set), except
 * `forced`, which is the built-in `openai` provider: its registry entry has forceStream,
 * so the proxy always streams upstream and aggregates SSE back to JSON clients.
 * `alwaysStreamed(format)`: the proxy sends stream:true whatever a client of that format asked.
 */
const UPSTREAMS = {
  honors: { handle: honors },
  json: { handle: () => json(completion()) },
  sse: { handle: () => sse() },
  strict: {
    handle: (body) => {
      const unknown = Object.keys(body).filter((k) => !STRICT_FIELDS.has(k));
      if (unknown.length) return json({ error: { message: `unknown fields: ${unknown.join(",")}` } }, 422);
      return honors(body);
    },
  },
  down: { handle: () => json({ error: { message: "upstream unavailable" } }, 503) },
  forced: { provider: "openai", alwaysStreamed: () => true, handle: honors },
  // Responses-API node: passthrough for Responses clients; translated requests always stream.
  resp: { apiType: "responses", alwaysStreamed: (format) => format !== "responses", handle: (body) => (body.stream === true ? sse(responsesSseBody()) : json(responseObject())) },
};
const MODES = Object.keys(UPSTREAMS);
const providerOf = (mode) => UPSTREAMS[mode].provider || `openai-compatible-${UPSTREAMS[mode].apiType || "chat"}-${mode}`;

/** Upstream bodies seen, in order: { mode, body }. */
let calls = [];
function fakeFetch(url, init) {
  const host = new URL(String(url)).hostname;
  // Compatible nodes live on <mode>.upstream.test; the built-in openai provider keeps its own host.
  const mode = host.endsWith(".upstream.test") ? host.split(".")[0] : "forced";
  const body = JSON.parse(init.body);
  calls.push({ mode, body });
  return UPSTREAMS[mode].handle(body);
}

// ---------- app under test ----------

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let adapter;
let budgets;
let routes;
let clientKey;
let clientKeyRef; // usage rows store "id:<keyId>", never the key string
let db;
const connectionIds = [];
let budgetScope;
let retryConfig;
let originalRetry503;

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
  ({ DEFAULT_RETRY_CONFIG: retryConfig } = await import("open-sse/config/runtimeConfig.js"));
  originalRetry503 = retryConfig[503];
  retryConfig[503] = { attempts: 1, delayMs: 0 };
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();

  // One OpenAI-compatible node per upstream mode; the base URL host picks the mode.
  const pricing = {};
  for (const mode of MODES) {
    const provider = providerOf(mode);
    let providerSpecificData = {};
    if (!UPSTREAMS[mode].provider) {
      const apiType = UPSTREAMS[mode].apiType || "chat";
      const node = await db.createProviderNode({
        id: provider,
        type: "openai-compatible",
        name: `Fake ${mode}`,
        prefix: mode,
        apiType,
        baseUrl: `http://${mode}.upstream.test/v1`,
      });
      providerSpecificData = { prefix: mode, apiType, baseUrl: node.baseUrl, nodeName: node.name };
    }
    const conn = await db.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${mode}-key`,
      apiKey: `sk-upstream-${mode}`,
      isActive: true,
      providerSpecificData,
    });
    connectionIds.push(conn.id);
    pricing[provider] = { [MODEL]: PRICE };
  }
  await db.updatePricing(pricing);
  await db.createCombo({ name: "fb-503", models: [`down/${MODEL}`, `honors/${MODEL}`] });
  await db.createCombo({ name: "fb-strict", models: [`strict/${MODEL}`, `honors/${MODEL}`] });

  const key = await db.createApiKey("matrix", "machine-fixture");
  clientKey = key.key;
  clientKeyRef = `id:${key.id}`;
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
  if (retryConfig) retryConfig[503] = originalRetry503;
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

// ---------- checks ----------
//
// Every property is a soft, labelled check so a cell reports all of its broken
// properties. A known-broken cell names the labels that are wrong on master today
// (KNOWN_BROKEN below); only those are allowed to fail, and the cell fails if any of
// them starts passing, so the entry gets removed with the fix.

let allowedWrong = new Set();
let seenWrong = new Set();

function check(value, label) {
  if (!allowedWrong.has(label)) return expect.soft(value, label);
  const real = expect(value, label);
  return new Proxy(
    {},
    {
      get: (_, matcher) =>
        (...args) => {
          try {
            real[matcher](...args);
          } catch {
            seenWrong.add(label);
          }
        },
    },
  );
}

/** One usage row with the upstream's real tokens, cost and the key's marked-up charge. */
function expectBilled({ rows, before, after }, mode) {
  check(rows, "usage rows").toHaveLength(1);
  const [row = {}] = rows;
  check(row.provider, "provider").toBe(providerOf(mode));
  check(row.apiKey, "api key").toBe(clientKeyRef);
  check(row.promptTokens, "prompt tokens (real, no buffer/estimate)").toBe(USAGE.prompt_tokens);
  check(row.completionTokens, "completion tokens").toBe(USAGE.completion_tokens);
  check(row.cost, "cost").toBeCloseTo(COST, 10);
  check(row.charge, "charge (markup plan)").toBeCloseTo(CHARGE, 10);
  check((after?.requests ?? 0) - (before.requests || 0), "budget requests").toBe(1);
  check((after?.charge ?? 0) - (before.charge || 0), "budget charge").toBeCloseTo(CHARGE, 10);
}

/** Failed request: an error in JSON, no usage row, budget untouched. */
function expectNotBilled({ res, rows, before, after }, status) {
  check(res.status, "status").toBe(status);
  check(res.headers.get("content-type"), "content-type").toContain("application/json");
  check(rows, "usage rows").toHaveLength(0);
  check((after?.requests ?? 0) - (before.requests || 0), "budget requests").toBe(0);
  check((after?.charge ?? 0) - (before.charge || 0), "budget charge").toBe(0);
}

/** `event:` + `data:` blocks of a named-event SSE body. */
const sseEvents = (text) =>
  text
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      return event ? { event, data: parseJson(data) } : null;
    })
    .filter(Boolean);

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
    // Usage is always folded into the finish chunk with the client buffer; the
    // usage-only trailer (choices: []) is the upstream's real count, sent only to
    // clients that asked for it with stream_options.include_usage.
    const finish = chunks.filter((c) => c.choices?.[0]?.finish_reason);
    const trailers = chunks.filter((c) => c.usage && !c.choices?.length);
    check(finish, "finish chunks").toHaveLength(1);
    check(finish[0]?.usage?.completion_tokens, "finish-chunk completion tokens").toBe(USAGE.completion_tokens);
    check(finish[0]?.usage?.prompt_tokens, "finish-chunk prompt tokens").toBe(USAGE.prompt_tokens + CLIENT_PROMPT_BUFFER);
    if (includeUsage) {
      check(trailers, "usage trailer (requested)").toHaveLength(1);
      check(trailers[0]?.usage?.completion_tokens, "trailer completion tokens").toBe(USAGE.completion_tokens);
      check(trailers[0]?.usage?.prompt_tokens, "trailer prompt tokens").toBe(USAGE.prompt_tokens);
    } else {
      check(trailers, "usage trailer (not requested)").toHaveLength(0);
    }
  } else {
    // Named-event SSE: every event's name matches its payload type, one terminal event, last.
    const events = sseEvents(text);
    const terminal = format === "claude" ? "message_stop" : "response.completed";
    check(events.filter((e) => e.event !== e.data?.type).map((e) => e.event), "event names match payload type").toEqual([]);
    check(events.filter((e) => e.event === terminal), `${terminal} count`).toHaveLength(1);
    check(events.at(-1)?.event, `${terminal} is last`).toBe(terminal);
    // Claude never sends [DONE]; a Responses passthrough may keep one trailing sentinel.
    check(count(text, "[DONE]"), "[DONE] count").toBeLessThanOrEqual(format === "claude" ? 0 : 1);
    const outputTokens =
      format === "claude"
        ? events.findLast((e) => e.event === "message_delta")?.data?.usage?.output_tokens
        : events.find((e) => e.event === terminal)?.data?.response?.usage?.output_tokens;
    check(outputTokens, "client output tokens").toBe(USAGE.completion_tokens);
  }
}

/** A non-streaming client never makes the proxy stream upstream or add stream_options. */
function expectNoLeak({ sent }, { wantSSE, format }) {
  if (wantSSE || sent.stream_options) return;
  for (const { mode, body } of calls) {
    if (UPSTREAMS[mode].alwaysStreamed?.(format)) {
      check(body.stream, `${mode} upstream stream`).toBe(true);
      continue;
    }
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
 * Cells that are wrong on master: real bugs, not fixed yet. Each lists the checks
 * that are wrong today; every other check in the cell is still enforced.
 * @type {Record<string, string[]>}
 */
const KNOWN_BROKEN = {};

/** Registers a cell: known-broken checks may fail, and must still be failing. */
function cell(name, fn) {
  it(name, async () => {
    allowedWrong = new Set(KNOWN_BROKEN[name] || []);
    seenWrong = new Set();
    await fn();
    const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b));
    expect(sorted(seenWrong), "known-broken checks still broken (fixed? update KNOWN_BROKEN)").toEqual(sorted(allowedWrong));
  });
}

describe("request matrix", () => {
  for (const c of cells) {
    cell(label(c), async () => {
      const r = await send({ ...c, model: `${UPSTREAMS[c.mode].provider || c.mode}/${MODEL}` });
      if (c.mode === "down") {
        // Retried once, then the upstream's 503 reaches the client; nothing billed.
        check(calls.length, "attempts").toBe(2);
        expectNotBilled(r, 503);
        return;
      }
      if (c.mode === "strict" && c.includeUsage) {
        // The client's own stream_options is forwarded as sent; the strict upstream's 422 is the answer.
        expectNotBilled(r, 422);
        return;
      }
      expectShape(r, c);
      expectBilled(r, c.mode);
      expectNoLeak(r, c);
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
        const c = { format, ...v, wantSSE: wantsSSE(v.stream, v.accept) };
        const name = `${combo} | ${format} | stream=${v.stream ?? "omitted"} | accept=${v.accept ?? "none"}${v.includeUsage ? " | include_usage" : ""}`;
        cell(name, async () => {
          const r = await send({ ...c, model: combo });
          check(calls[0]?.mode, "first target").toBe(first);
          check(calls.at(-1)?.mode, "served by").toBe(served);
          if (first === "down") {
            // Every attempt derives from the client's original body: no stream flag carried over.
            const flags = (b) => JSON.stringify([b.stream, b.stream_options]);
            check(flags(calls.at(-1).body), "fallback body stream flags").toBe(flags(calls[0].body));
          }
          expectShape(r, c);
          expectBilled(r, served);
          expectNoLeak(r, c);
        });
      }
});
