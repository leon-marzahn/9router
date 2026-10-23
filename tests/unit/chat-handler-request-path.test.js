// Request-path coverage for src/sse/handlers/chat.js: request validation, combo
// expansion + fallback order (real handleComboChat), the multi-account loop
// (429/5xx/auth fallback, cooldown passthrough, all-rate-limited), and the
// callbacks handed to chatCore. handleChatCore is mocked; no upstream calls.
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
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));

import { getSettings } from "@/lib/localDb";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { augmentModelsWithCapacityAdapter } from "open-sse/services/capacityAdapter.js";
import { getModelInfo, getComboModels } from "../../src/sse/services/model.js";
import {
  getProviderCredentials, markAccountUnavailable, clearAccountError, extractApiKey, isValidApiKey,
} from "../../src/sse/services/auth.js";
import { enforceKeyAccess } from "../../src/sse/services/keyAccess.js";
import { updateProviderCredentials } from "../../src/sse/services/tokenRefresh.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../../src/sse/services/antigravityQuota.js";
import { createErrorResult } from "open-sse/utils/error.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const SECRET = "sk-upstream-SECRET-123";

function req(body, { path = "/v1/chat/completions", headers = {} } = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const chatBody = (model) => ({ model, messages: [{ role: "user", content: "hi" }] });
const ok = (tag) => ({ success: true, response: Response.json({ tag }) });
const acct = (id, extra = {}) => ({ connectionId: id, connectionName: id, apiKey: SECRET, ...extra });

/** Accounts handed out in order, skipping excluded ids. */
function accounts(list) {
  getProviderCredentials.mockImplementation(async (_p, excluded) => list.find((a) => !excluded.has(a.connectionId)) || null);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getComboModels.mockResolvedValue(null);
  getModelInfo.mockImplementation(async (m) => {
    const i = m.indexOf("/");
    return i < 0 ? { provider: null, model: m } : { provider: m.slice(0, i), model: m.slice(i + 1) };
  });
  accounts([acct("a1")]);
  markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  handleChatCore.mockResolvedValue(ok("default"));
});

describe("request validation", () => {
  it("rejects invalid JSON with 400", async () => {
    const res = await handleChat(req("{nope"));
    expect(res.status).toBe(400);
  });

  it("rejects a missing model with 400", async () => {
    const res = await handleChat(req({ messages: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Missing model/);
  });

  it("enforces requireApiKey: missing and invalid keys get 401", async () => {
    getSettings.mockResolvedValue({ requireApiKey: true });
    expect((await handleChat(req(chatBody("openai/gpt-4o")))).status).toBe(401);

    extractApiKey.mockReturnValue("sk-client");
    isValidApiKey.mockResolvedValueOnce(false);
    const res = await handleChat(req(chatBody("openai/gpt-4o"), { headers: { authorization: "Bearer sk-client" } }));
    expect(res.status).toBe(401);
    expect(handleChatCore).not.toHaveBeenCalled();
    extractApiKey.mockReturnValue(null);
  });

  it("returns the key-access denial untouched", async () => {
    enforceKeyAccess.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    expect((await handleChat(req(chatBody("openai/gpt-4o")))).status).toBe(403);
    expect(getProviderCredentials).not.toHaveBeenCalled();
  });

  it("404s an explicit combo/ prefix that names no combo", async () => {
    const res = await handleChat(req(chatBody("combo/missing")));
    expect(res.status).toBe(404);
  });

  it("400s a bare model name that is neither provider/model nor combo", async () => {
    const res = await handleChat(req(chatBody("nonsense")));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Invalid model format/);
  });

  it("400s when a request pipeline throws", async () => {
    getSettings.mockResolvedValue({ requestPipelines: [{ name: "bad", rules: [{ regex: "(", replacement: "x" }] }] });
    const res = await handleChat(req(chatBody("openai/gpt-4o"), { headers: { "x-regent-pipeline": "bad" } }));
    expect(res.status).toBe(400);
  });
});

describe("single model dispatch", () => {
  it("passes provider/model, source-format override and settings to chatCore", async () => {
    getSettings.mockResolvedValue({ rtkEnabled: true, providerThinking: { openai: { mode: "high" } }, providerOverrides: { openai: { timeout: 5 } } });
    const res = await handleChat(req(chatBody("openai/gpt-4o"), { path: "/v1/responses" }));
    expect(res.status).toBe(200);
    const opts = handleChatCore.mock.calls[0][0];
    expect(opts.body.model).toBe("openai/gpt-4o");
    expect(opts.modelInfo).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(opts.sourceFormatOverride).toBe("openai-responses");
    expect(opts.rtkEnabled).toBe(true);
    expect(opts.providerThinking).toEqual({ mode: "high" });
    expect(opts.providerOverrides).toEqual({ timeout: 5 });
    expect(opts.connectionId).toBe("a1");
  });

  it("detects the Claude source format on /v1/messages", async () => {
    await handleChat(req({ model: "openai/gpt-4o", max_tokens: 10, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { path: "/v1/messages" }));
    expect(handleChatCore.mock.calls[0][0].sourceFormatOverride).toBe("claude");
  });

  it("strips the [1m] context marker before resolution", async () => {
    await handleChat(req(chatBody("anthropic/claude-x[1m]")));
    expect(getModelInfo).toHaveBeenCalledWith("anthropic/claude-x");
    expect(getProviderCredentials.mock.calls[0][3].requestedModel).toBe("claude-x[1m]");
  });

  it("wires onRequestSuccess and onCredentialsRefreshed to the selected account", async () => {
    await handleChat(req(chatBody("openai/gpt-4o")));
    const opts = handleChatCore.mock.calls[0][0];
    await opts.onRequestSuccess();
    expect(clearAccountError).toHaveBeenCalledWith("a1", expect.objectContaining({ connectionId: "a1" }), "gpt-4o");
    expect(clearAntigravityStrikes).toHaveBeenCalledWith("a1", "gpt-4o");
    await opts.onCredentialsRefreshed({ accessToken: "new" });
    expect(updateProviderCredentials).toHaveBeenCalledWith("a1", expect.objectContaining({ accessToken: "new", testStatus: "active" }));
  });

  it("fetches and persists a missing projectId for antigravity", async () => {
    accounts([acct("ag1", { accessToken: "at" })]);
    await handleChat(req(chatBody("antigravity/gemini-x")));
    expect(handleChatCore.mock.calls[0][0].credentials.projectId).toBe("proj-1");
    expect(updateProviderCredentials).toHaveBeenCalledWith("ag1", { projectId: "proj-1" });
  });
});

describe("multi-account fallback", () => {
  it.each([429, 500, 503, 401])("moves to the next account on %i", async (status) => {
    accounts([acct("a1"), acct("a2")]);
    handleChatCore
      .mockResolvedValueOnce(createErrorResult(status, "boom", 1234))
      .mockResolvedValueOnce(ok("second"));
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(await res.json()).toEqual({ tag: "second" });
    expect(handleChatCore.mock.calls.map((c) => c[0].connectionId)).toEqual(["a1", "a2"]);
    // cooldown hint from upstream is forwarded to the lock logic
    expect(markAccountUnavailable).toHaveBeenCalledWith("a1", status, "boom", "openai", "gpt-4o", 1234);
    const excluded = getProviderCredentials.mock.calls[1][1];
    expect([...excluded]).toEqual(["a1"]);
  });

  it("returns the upstream error as-is when fallback is not warranted", async () => {
    accounts([acct("a1"), acct("a2")]);
    markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    handleChatCore.mockResolvedValueOnce(createErrorResult(400, "bad request"));
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(400);
    expect(handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("returns the last error once every account is exhausted", async () => {
    accounts([acct("a1"), acct("a2")]);
    handleChatCore.mockResolvedValue(createErrorResult(502, "upstream down"));
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("upstream down");
    expect(text).not.toContain(SECRET);
  });

  it("returns 503 with Retry-After when all accounts are rate limited", async () => {
    let n = 0;
    getProviderCredentials.mockImplementation(async () => (n++ === 0
      ? acct("a1")
      : { allRateLimited: true, retryAfter: new Date(Date.now() + 30_000).toISOString(), retryAfterHuman: "reset after 30s" }));
    handleChatCore.mockResolvedValueOnce(createErrorResult(429, "rate limited"));
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const text = await res.text();
    expect(text).toContain("rate limited");
    expect(text).not.toContain(SECRET);
  });

  it("404s when the provider has no active credentials", async () => {
    getProviderCredentials.mockResolvedValue(null);
    const res = await handleChat(req(chatBody("openai/gpt-4o")));
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/No active credentials/);
  });

  it("antigravity 429 with a live quota reset skips the persisted lock and falls back", async () => {
    accounts([acct("ag1", { projectId: "p" }), acct("ag2", { projectId: "p" })]);
    handleAntigravityQuotaError.mockResolvedValueOnce(Date.now() + 60_000);
    handleChatCore.mockResolvedValueOnce(createErrorResult(429, "quota")).mockResolvedValueOnce(ok("ag2"));
    const res = await handleChat(req(chatBody("antigravity/gemini-x")));
    expect(await res.json()).toEqual({ tag: "ag2" });
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });
});

describe("combo expansion", () => {
  it("tries combo members in order and falls back on failure", async () => {
    getComboModels.mockImplementation(async (m) => (m === "mycombo" ? ["openai/a", "anthropic/b", "openai/c"] : null));
    handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "b"
      ? ok("b")
      : createErrorResult(503, "down")));
    markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    const res = await handleChat(req(chatBody("mycombo")));
    expect(await res.json()).toEqual({ tag: "b" });
    expect(handleChatCore.mock.calls.map((c) => c[0].body.model)).toEqual(["openai/a", "anthropic/b"]);
  });

  it("accepts the explicit combo/ prefix", async () => {
    getComboModels.mockImplementation(async (m) => (m === "mycombo" ? ["openai/a"] : null));
    const res = await handleChat(req(chatBody("combo/mycombo")));
    expect(res.status).toBe(200);
    expect(handleChatCore.mock.calls[0][0].body.model).toBe("openai/a");
  });

  it("expands a nested combo member", async () => {
    getComboModels.mockImplementation(async (m) => ({ outer: ["inner"], inner: ["openai/x"] })[m] || null);
    const res = await handleChat(req(chatBody("outer")));
    expect(res.status).toBe(200);
    expect(handleChatCore.mock.calls[0][0].body.model).toBe("openai/x");
  });

  it("surfaces an error when every combo member fails", async () => {
    getComboModels.mockImplementation(async (m) => (m === "c" ? ["openai/a", "openai/b"] : null));
    markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    handleChatCore.mockResolvedValue(createErrorResult(503, "down"));
    const res = await handleChat(req(chatBody("c")));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(handleChatCore).toHaveBeenCalledTimes(2);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("routes a fusion combo through handleFusionChat", async () => {
    getComboModels.mockImplementation(async (m) => (m === "fz" ? ["openai/a", "openai/b"] : null));
    getSettings.mockResolvedValue({ comboStrategies: { fz: { fallbackStrategy: "fusion" } } });
    const res = await handleChat(req(chatBody("fz")));
    expect(res).toBeInstanceOf(Response);
    expect(handleChatCore).toHaveBeenCalled();
  });

  it("hands the client's signal to every fusion panel call", async () => {
    getComboModels.mockImplementation(async (m) => (m === "fz" ? ["openai/a", "openai/b"] : null));
    getSettings.mockResolvedValue({ comboStrategies: { fz: { fallbackStrategy: "fusion" } } });
    const ctrl = new AbortController();
    const r = new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody("fz")), signal: ctrl.signal,
    });
    await handleChat(r);
    const panelCalls = handleChatCore.mock.calls.filter(([o]) => o.clientSignal);
    expect(panelCalls.length).toBe(2);
    ctrl.abort();
    for (const [o] of panelCalls) expect(o.clientSignal.aborted).toBe(true);
  });

  it("switches a single model to a capacity-adapter combo when needed", async () => {
    augmentModelsWithCapacityAdapter.mockImplementationOnce((models) => [...models, "openai/vision"]);
    handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "vision" ? ok("v") : createErrorResult(503, "x")));
    markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    const res = await handleChat(req(chatBody("openai/text")));
    expect(await res.json()).toEqual({ tag: "v" });
  });
});
