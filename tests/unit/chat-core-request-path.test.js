// Request-path coverage for open-sse/handlers/chatCore.js with a mocked
// executor: source-format detection + translation dispatch, streaming vs JSON,
// 401 refresh-then-retry, upstream/executor errors, and that credentials never
// reach client-facing error bodies. No network.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { executor } = vi.hoisted(() => ({
  executor: { noAuth: false, execute: null, refreshCredentials: null },
}));

vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => executor }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {},
    logConvertedResponse() {}, logError() {}, appendProviderChunk() {}, appendConvertedChunk() {},
    appendOpenAIChunk() {}, logOpenAIRequest() {}, logOpenAIResponse() {},
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/services/tokenRefresh.js", async (orig) => ({
  ...(await orig()),
  // no backoff delays in tests
  refreshWithRetry: vi.fn(async (fn) => fn()),
}));

const { handleChatCore, isTokenExpiringSoon, stripContinuityFields } = await import("../../open-sse/handlers/chatCore.js");
const { trackPendingRequest } = await import("@/lib/usageDb.js");

const SECRET = "sk-upstream-SECRET-123";
const RT = "rt-SECRET-456";

const jsonCompletion = (content = "hello") => new Response(JSON.stringify({
  id: "chatcmpl-1", object: "chat.completion", model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
}), { status: 200, headers: { "content-type": "application/json" } });

const sseCompletion = () => new Response([
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

const upstream = (response) => ({ response, url: "https://api.example.test/v1/chat/completions", headers: { Authorization: `Bearer ${SECRET}` }, transformedBody: null });

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn(), fmtThink: () => null });

function run(overrides = {}) {
  return handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "groq", model: "llama-3.3-70b-versatile" },
    credentials: { apiKey: SECRET, accessToken: SECRET, refreshToken: RT, connectionId: "conn-1", connectionName: "acc", providerSpecificData: {} },
    log: log(),
    connectionId: "conn-1",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  executor.noAuth = false;
  executor.execute = vi.fn(async () => upstream(jsonCompletion()));
  executor.refreshCredentials = vi.fn(async () => null);
});

describe("format detection and translation dispatch", () => {
  it("passes an OpenAI body straight to an OpenAI target", async () => {
    const result = await run();
    expect(result.success).toBe(true);
    const sent = executor.execute.mock.calls[0][0];
    expect(sent.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.stream).toBe(false);
    expect((await result.response.json()).choices[0].message.content).toBe("hello");
  });

  it("detects a Claude body and translates it to OpenAI, then the response back to Claude", async () => {
    const result = await run({
      body: { model: "gpt-4o", max_tokens: 50, stream: false, system: "be brief", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    });
    const sent = executor.execute.mock.calls[0][0].body;
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(sent.messages.at(-1).role).toBe("user");
    const out = await result.response.json();
    expect(out.type).toBe("message");
    expect(out.content[0]).toMatchObject({ type: "text", text: "hello" });
  });

  it("honours sourceFormatOverride for the Responses API", async () => {
    await run({ body: { model: "gpt-4o", stream: false, input: "hi" }, sourceFormatOverride: "openai-responses" });
    const sent = executor.execute.mock.calls[0][0].body;
    expect(sent.input ?? sent.messages).toBeDefined();
  });

  it("injects provider-level thinking only when the client did not set it", async () => {
    await run({ providerThinking: { mode: "high" }, modelInfo: { provider: "groq", model: "openai/gpt-oss-120b" } });
    expect(executor.execute.mock.calls[0][0].body.reasoning_effort).toBe("high");
    await run({ body: { model: "gpt-4o", stream: false, reasoning_effort: "low", messages: [{ role: "user", content: "hi" }] }, providerThinking: { mode: "high" }, modelInfo: { provider: "groq", model: "openai/gpt-oss-120b" } });
    expect(executor.execute.mock.calls[1][0].body.reasoning_effort).toBe("low");
  });

  it("returns the bypass response for Claude Code warmup requests without calling upstream", async () => {
    const result = await run({
      body: { model: "gpt-4o", messages: [{ role: "user", content: "Warmup" }] },
      userAgent: "claude-cli/1.0",
    });
    expect(result).toBeTruthy();
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe("streaming vs non-streaming", () => {
  it("streams SSE when the client asks for stream:true", async () => {
    executor.execute = vi.fn(async () => upstream(sseCompletion()));
    const result = await run({ body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] } });
    expect(result.success).toBe(true);
    expect(executor.execute.mock.calls[0][0].stream).toBe(true);
    expect(result.response.headers.get("content-type")).toMatch(/event-stream/);
    const text = await result.response.text();
    expect(text).toContain("hel");
    expect(text).toContain("[DONE]");
  });

  // OpenAI Chat Completions: an absent `stream` means a JSON response.
  it("defaults to non-streaming when stream is omitted", async () => {
    executor.execute = vi.fn(async () => upstream(jsonCompletion("hi")));
    const result = await run({ body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] } });
    expect(executor.execute.mock.calls[0][0].stream).toBe(false);
    expect(result.response.headers.get("content-type")).toContain("application/json");
  });

  it("prefers JSON when the client sends Accept: application/json", async () => {
    await run({
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
    });
    expect(executor.execute.mock.calls[0][0].stream).toBe(false);
  });
});

describe("token refresh then retry", () => {
  it("refreshes on 401, persists the new token and retries once", async () => {
    executor.execute = vi.fn()
      .mockResolvedValueOnce(upstream(new Response("unauthorized", { status: 401 })))
      .mockResolvedValueOnce(upstream(jsonCompletion("after-refresh")));
    executor.refreshCredentials = vi.fn(async () => ({ accessToken: "fresh", refreshToken: "rt-new" }));
    const onCredentialsRefreshed = vi.fn(async () => {});
    const credentials = { accessToken: "old", refreshToken: "rt-old", providerSpecificData: {} };
    const result = await run({ credentials, onCredentialsRefreshed });
    expect(result.success).toBe(true);
    expect((await result.response.json()).choices[0].message.content).toBe("after-refresh");
    expect(onCredentialsRefreshed).toHaveBeenCalledWith({ accessToken: "fresh", refreshToken: "rt-new" });
    expect(executor.execute.mock.calls[1][0].credentials.accessToken).toBe("fresh");
    expect(credentials.refreshToken).toBe("rt-new");
  });

  it("returns the 401 as an error result when refresh fails", async () => {
    executor.execute = vi.fn(async () => upstream(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })));
    const result = await run();
    expect(executor.refreshCredentials).toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
  });

  it("keeps the original error when the retry after refresh fails", async () => {
    executor.execute = vi.fn()
      .mockResolvedValueOnce(upstream(new Response("forbidden", { status: 403 })))
      .mockRejectedValueOnce(new Error("socket hang up"));
    executor.refreshCredentials = vi.fn(async () => ({ accessToken: "fresh" }));
    const onCredentialsRefreshed = vi.fn(async () => { throw new Error("db down"); });
    const result = await run({ onCredentialsRefreshed });
    expect(result.status).toBe(403);
  });

  it("survives a refresh that throws", async () => {
    executor.execute = vi.fn(async () => upstream(new Response("unauthorized", { status: 401 })));
    executor.refreshCredentials = vi.fn(async () => { throw new Error("invalid_grant"); });
    expect((await run()).status).toBe(401);
  });

  it("skips refresh for noAuth providers", async () => {
    executor.noAuth = true;
    executor.execute = vi.fn(async () => upstream(new Response("unauthorized", { status: 401 })));
    await run();
    expect(executor.refreshCredentials).not.toHaveBeenCalled();
  });
});

describe("error propagation", () => {
  it.each([429, 500, 503])("returns upstream %i as a failed result with no credentials in the body", async (status) => {
    executor.execute = vi.fn(async () => upstream(new Response(JSON.stringify({ error: { message: "upstream said no" } }), {
      status, headers: { "content-type": "application/json", "retry-after": "7" },
    })));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.status).toBe(status);
    expect(result.response.status).toBe(status);
    const text = await result.response.text();
    expect(text).toContain("upstream said no");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(RT);
    expect(trackPendingRequest).toHaveBeenCalledWith("llama-3.3-70b-versatile", "groq", "conn-1", false, true);
  });

  it("maps an executor throw to 502 without leaking credentials", async () => {
    executor.execute = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const result = await run();
    expect(result.status).toBe(502);
    const text = await result.response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(RT);
  });

  it("maps an AbortError to 499", async () => {
    executor.execute = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    expect((await run()).status).toBe(499);
  });

  it("masks proxy credentials in the proxy log line", async () => {
    const l = log();
    await run({
      log: l,
      credentials: { apiKey: SECRET, providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://user:pw-SECRET@proxy.test:8080", connectionNoProxy: "localhost" } },
    });
    const logged = JSON.stringify([l.info.mock.calls, l.debug.mock.calls]);
    expect(logged).toContain("http://proxy.test:8080");
    expect(logged).not.toContain("pw-SECRET");
    expect(executor.execute.mock.calls[0][0].proxyOptions.connectionProxyEnabled).toBe(true);
  });
});

describe("helpers", () => {
  it("isTokenExpiringSoon", () => {
    expect(isTokenExpiringSoon(null)).toBe(false);
    expect(isTokenExpiringSoon(new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(isTokenExpiringSoon(new Date(Date.now() + 3_600_000).toISOString())).toBe(false);
  });

  it("stripContinuityFields drops translator-internal fields", () => {
    const body = { messages: [{ role: "assistant", content: "x", encrypted_content: "e", reasoning_encrypted_content: "r" }] };
    expect(stripContinuityFields(body).messages[0]).toEqual({ role: "assistant", content: "x" });
    expect(stripContinuityFields(null)).toBe(null);
  });
});
