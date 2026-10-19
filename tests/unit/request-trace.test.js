// Routing trace for the Usage request inspector (src/lib/requestTrace.js):
// fallback attempts recorded through the real chat.js account/combo loops,
// detail folding from chatCore, bounds, and that no credential ever reaches a
// stored trace or the /api/usage/traces/:id response.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  stripComboPrefix: (m) => (typeof m === "string" && m.startsWith("combo/") ? m.slice(6) : m),
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => null),
  enforceKeyAccess: vi.fn(async () => null),
  filterAdapterModels: vi.fn(async (_ctx, models) => models),
  extractClientApiKey: vi.fn(() => null),
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: vi.fn(async () => null) }));
vi.mock("../../src/sse/services/stepReadiness.js", () => ({ isStepReady: vi.fn(async () => true) }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_p, c) => ({ ...c })),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => "proj-1") }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
}));
vi.mock("@/lib/db/repos/usageRepo.js", () => ({ calculateCost: vi.fn(async () => 0.0123) }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));

import { getSettings } from "@/lib/localDb";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { getModelInfo, getComboModels } from "../../src/sse/services/model.js";
import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
import { createErrorResult } from "open-sse/utils/error.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { handleChat } from "../../src/sse/handlers/chat.js";
import { recordRequestDetail, buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";
import { GET } from "../../src/app/api/usage/traces/[id]/route.js";
import {
  __test__, startTrace, runWithTrace, beginAttempt, annotateAttempt, endAttempt, getTrace,
  redactSecrets, MAX_TRACES, MAX_ATTEMPTS,
} from "../../src/lib/requestTrace.js";

const SECRET = "sk-upstream-SECRET-1234567890";
const OAUTH = "ya29.OAUTH-access-token-abcdefghijklmnop";
const PROXY = "http://proxyuser:proxypass@10.0.0.1:8080";
const SECRETS = [SECRET, OAUTH, "proxypass", "proxyuser", "cookie-value-xyz"];

const req = (body) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, cookie: "auth_token=cookie-value-xyz" },
  body: JSON.stringify(body),
});
const chatBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });
const ok = () => ({ success: true, response: Response.json({ ok: true }) });
const acct = (id) => ({
  connectionId: id, connectionName: `Account ${id}`, apiKey: SECRET, accessToken: OAUTH, refreshToken: OAUTH,
  providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: PROXY },
});
const latest = () => getTrace(__test__.latestId());
const expectNoSecrets = (value) => {
  const text = JSON.stringify(value);
  for (const s of SECRETS) expect(text).not.toContain(s);
};

beforeEach(() => {
  vi.clearAllMocks();
  __test__.reset();
  getSettings.mockResolvedValue({});
  getComboModels.mockResolvedValue(null);
  getModelInfo.mockImplementation(async (m) => {
    const i = m.indexOf("/");
    return i < 0 ? { provider: null, model: m } : { provider: m.slice(0, i), model: m.slice(i + 1) };
  });
  getProviderCredentials.mockImplementation(async (_p, excluded) => [acct("a1"), acct("a2")].find((a) => !excluded.has(a.connectionId)) || null);
  markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
});

describe("fallback trace recording", () => {
  it("records a 429 account fallback, then the successful attempt", async () => {
    handleChatCore
      .mockResolvedValueOnce(createErrorResult(429, `quota exceeded for key ${SECRET} via ${PROXY} authorization: Bearer ${OAUTH}`))
      .mockResolvedValueOnce(ok());
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(200);

    const trace = latest();
    expect(trace.requestedModel).toBe("openai/gpt-4o");
    expect(trace.endpoint).toBe("/v1/chat/completions");
    expect(trace.outcome).toEqual({ status: "ok", statusCode: 200 });
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]).toMatchObject({
      provider: "openai", model: "gpt-4o", connectionId: "a1", connectionLabel: "Account a1",
      status: "error", statusCode: 429, reason: "rate_limit", fallback: "account",
    });
    expect(trace.attempts[1]).toMatchObject({ connectionId: "a2", status: "ok", statusCode: 200 });
    expect(trace.attempts[0].error).toMatch(/quota exceeded/);
    expectNoSecrets(trace);
    expectNoSecrets(__test__.raw(trace.id));
    // chatCore gets the attempt handle so it can add formats/tokens.
    expect(handleChatCore.mock.calls[1][0].traceAttempt).toMatchObject({ connectionId: "a2" });
  });

  it("records combo expansion and a model fallback on 5xx", async () => {
    getComboModels.mockImplementation(async (m) => (m === "mycombo" ? ["openai/a", "anthropic/b"] : null));
    markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "b" ? ok() : createErrorResult(502, "bad gateway")));
    await handleChat(req(chatBody("mycombo")));
    const trace = latest();
    expect(trace.combo).toMatchObject({ name: "mycombo", models: ["openai/a", "anthropic/b"] });
    expect(trace.attempts.map((a) => [a.provider, a.model, a.status, a.reason, a.fallback])).toEqual([
      ["openai", "a", "error", "server", "model"],
      ["anthropic", "b", "ok", undefined, undefined],
    ]);
  });

  it("records an all-accounts-cooling-down skip", async () => {
    getProviderCredentials.mockResolvedValue({
      allRateLimited: true, lastError: "rate limited",
      retryAfter: new Date(Date.now() + 60000).toISOString(), retryAfterHuman: "1m",
    });
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(503);
    const trace = latest();
    expect(trace.outcome.status).toBe("error");
    expect(trace.attempts[0]).toMatchObject({ skipped: true, reason: "cooldown", statusCode: 503 });
  });

  it("never breaks a request when tracing throws", async () => {
    handleChatCore.mockResolvedValueOnce(ok());
    const request = req(chatBody("openai/gpt-4o"));
    // startTrace registers the trace in a Map; make that throw.
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(() => { throw new Error("boom"); });
    let res;
    try {
      res = await handleChat(request);
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
  });
});

describe("chatCore detail folding", () => {
  it("links the detail to the trace and keeps metadata only", () => {
    const trace = startTrace({ endpoint: "/v1/chat/completions" });
    const attempt = runWithTrace(trace, () => beginAttempt({ provider: "openai", model: "gpt-4o", connectionId: "a1" }));
    annotateAttempt(attempt, { sourceFormat: "claude", targetFormat: "openai", stream: true });
    const detail = buildRequestDetail({
      provider: "openai", model: "gpt-4o", connectionId: "a1",
      latency: { ttft: 120, total: 900 },
      tokens: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 40, reasoning_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }], headers: { authorization: `Bearer ${SECRET}` } },
      response: { content: "secret answer" },
    });
    recordRequestDetail(attempt, detail);
    expect(saveRequestDetail).toHaveBeenCalledWith(expect.objectContaining({ traceId: trace.id }));
    const t = getTrace(trace.id);
    expect(t.attempts[0]).toMatchObject({
      sourceFormat: "claude", targetFormat: "openai", stream: true, status: "ok",
      latencyMs: 900, ttftMs: 120, tokens: { in: 100, out: 20, cached: 40, reasoning: 5 },
    });
    expect(t.tokens).toEqual({ in: 100, out: 20, cached: 40, reasoning: 5 });
    const text = JSON.stringify(t);
    expect(text).not.toContain("secret prompt");
    expect(text).not.toContain("secret answer");
    expectNoSecrets(t);
  });

  it("folds an upstream error with redaction", () => {
    const trace = startTrace({});
    const attempt = beginAttempt({ provider: "openai", model: "m" }, trace);
    recordRequestDetail(attempt, buildRequestDetail(
      { provider: "openai", model: "m", response: { error: `invalid x-api-key: ${SECRET}`, status: 401 } },
      { status: "error" },
    ));
    expect(getTrace(trace.id).attempts[0]).toMatchObject({ status: "error", statusCode: 401, reason: "auth" });
    expectNoSecrets(getTrace(trace.id));
  });

  it("marks a stream as streaming until its completion detail arrives", () => {
    const trace = startTrace({});
    const attempt = beginAttempt({ provider: "p", model: "m" }, trace);
    recordRequestDetail(attempt, buildRequestDetail({ provider: "p", model: "m", response: { content: "[Streaming in progress...]", type: "streaming" } }));
    expect(getTrace(trace.id).attempts[0].status).toBe("streaming");
    recordRequestDetail(attempt, buildRequestDetail({ provider: "p", model: "m", tokens: { prompt_tokens: 3, completion_tokens: 2 }, response: { content: "done", type: "streaming" } }));
    expect(getTrace(trace.id).attempts[0]).toMatchObject({ status: "ok", tokens: { in: 3, out: 2 } });
  });

  it("still saves the detail without a trace", () => {
    const detail = buildRequestDetail({ provider: "p", model: "m" });
    recordRequestDetail(null, detail);
    expect(saveRequestDetail).toHaveBeenCalledWith(detail);
    expect(detail.traceId).toBeUndefined();
  });
});

describe("bounds", () => {
  it("evicts the oldest traces past MAX_TRACES", () => {
    const first = startTrace({});
    for (let i = 0; i < MAX_TRACES + 10; i++) startTrace({});
    expect(__test__.size()).toBe(MAX_TRACES);
    expect(getTrace(first.id)).toBeNull();
  });

  it("caps attempts per trace", () => {
    const trace = startTrace({});
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) endAttempt(beginAttempt({ provider: "p", model: "m" }, trace), { status: 500 });
    const t = getTrace(trace.id);
    expect(t.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(t.truncatedAttempts).toBe(3);
  });

  it("drops traces older than the retention window", () => {
    const trace = startTrace({});
    __test__.raw(trace.id).startedAt -= 25 * 60 * 60 * 1000;
    startTrace({});
    expect(getTrace(trace.id)).toBeNull();
  });
});

describe("redactSecrets", () => {
  it.each([
    [`key ${SECRET}`, SECRET],
    [`Authorization: Bearer ${OAUTH}`, OAUTH],
    [PROXY, "proxypass"],
    ["socks5://u1:p4ss@host:1080 failed", "p4ss"],
    ['{"api_key":"abc123secret"}', "abc123secret"],
    ["token=deadbeefcafe", "deadbeefcafe"],
    ["AIzaSyA1234567890abcdefghijklmnop", "SyA1234567890abcdefghijklmnop"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "dozjgNryP4J3jVmNHl0w5N"],
  ])("masks %s", (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
  });

  it("keeps ordinary error text and clamps length", () => {
    expect(redactSecrets("Rate limit reached for gpt-4o")).toBe("Rate limit reached for gpt-4o");
    expect(redactSecrets("x ".repeat(500)).length).toBeLessThanOrEqual(241);
  });
});

describe("GET /api/usage/traces/:id", () => {
  const call = (id) => GET(new Request(`http://localhost/api/usage/traces/${id}`), { params: Promise.resolve({ id }) });

  it("returns the trace with cost and no secrets", async () => {
    handleChatCore
      .mockResolvedValueOnce(createErrorResult(429, `limit for ${SECRET} via ${PROXY}`))
      .mockResolvedValueOnce(ok());
    await handleChat(req(chatBody("openai/gpt-4o")));
    const id = __test__.latestId();
    __test__.raw(id).attempts[1].tokens = { in: 10, out: 5 };
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.attempts).toHaveLength(2);
    expect(body.cost).toBe(0.0123);
    expectNoSecrets(body);
    for (const field of ["apiKey", "accessToken", "refreshToken", "providerSpecificData", "headers", "cookie"]) {
      expect(JSON.stringify(body)).not.toContain(`"${field}"`);
    }
  });

  it("400s a malformed id and 404s an unknown one", async () => {
    expect((await call("../../etc")).status).toBe(400);
    expect((await call("tr_doesnotexist")).status).toBe(404);
  });
});
