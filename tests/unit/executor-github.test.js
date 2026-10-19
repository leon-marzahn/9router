// GitHub Copilot executor: header building, request transforms, routing between
// /chat/completions, /responses and /v1/messages, SSE re-translation and token refresh.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  // Errors are returned (not thrown) by the vi.fn and re-thrown here, so the mock
  // itself never records a rejected result.
  proxyAwareFetch: async (...args) => {
    const r = await fetchMock(...args);
    if (r instanceof Error) throw r;
    return r;
  },
}));

const { GithubExecutor } = await import("../../open-sse/executors/github.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");

function sseBody(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
const sseRes = (chunks, status = 200) => new Response(sseBody(chunks), { status, headers: { "content-type": "text/event-stream" } });
const jsonRes = (status, data) => new Response(typeof data === "string" ? data : JSON.stringify(data), { status });

beforeEach(() => fetchMock.mockReset());

describe("GithubExecutor headers & transforms", () => {
  it("prefers copilotToken over accessToken for Bearer auth", () => {
    const ex = new GithubExecutor();
    expect(ex.buildHeaders({ copilotToken: "cop", accessToken: "gh" }).Authorization).toBe("Bearer cop");
    expect(ex.buildHeaders({ accessToken: "gh" }, false).Authorization).toBe("Bearer gh");
    expect(ex.buildHeaders({ accessToken: "gh" }, false).Accept).toBe("application/json");
    expect(ex.buildHeaders({ accessToken: "gh" }, true).Accept).toBe("text/event-stream");
    expect(ex.buildHeaders({ accessToken: "gh" })["copilot-integration-id"]).toBe("vscode-chat");
  });

  it("renames max_tokens → max_completion_tokens for gpt-5/o-series and drops reasoning_effort none", () => {
    const ex = new GithubExecutor();
    const out = ex.transformRequest("gpt-5", { max_tokens: 100, reasoning_effort: "none" });
    expect(out.max_completion_tokens).toBe(100);
    expect(out.max_tokens).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
    expect(ex.transformRequest("gpt-4o", { max_tokens: 5 }).max_tokens).toBe(5);
  });

  it("sanitizes non text/image parts to text for /chat/completions", () => {
    const ex = new GithubExecutor();
    const out = ex.sanitizeMessagesForChatCompletions({
      messages: [
        { role: "assistant", content: null, tool_calls: [{}] },
        { role: "user", content: "s" },
        { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "u" } }, { type: "tool_result", content: { x: 1 } }, { type: "thinking", text: "" }] },
        { role: "user", content: [{ type: "text", text: "" }] },
      ],
    });
    expect(out.messages[0].content).toBeNull();
    expect(out.messages[1].content).toBe("s");
    expect(out.messages[2].content.map(p => p.type)).toEqual(["text", "image_url", "text", "text"]);
    expect(out.messages[2].content[2].text).toBe('{"x":1}');
    expect(out.messages[3].content).toBeNull();
    expect(ex.sanitizeMessagesForChatCompletions({})).toEqual({});
  });

  it("only non-claude/gemini models may use /responses", () => {
    const ex = new GithubExecutor();
    expect(ex.supportsResponsesEndpoint("gpt-5-codex")).toBe(true);
    expect(ex.supportsResponsesEndpoint("gemini-2.5-pro")).toBe(false);
    expect(ex.supportsResponsesEndpoint("Claude-x")).toBe(false);
    expect(ex.isClaudeModel("claude-sonnet-4")).toBe(true);
  });
});

describe("GithubExecutor.execute routing", () => {
  it("gpt model goes to /chat/completions with sanitized body", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));
    const ex = new GithubExecutor();
    const out = await ex.execute({ model: "gpt-4o", body: { messages: [{ role: "user", content: [{ type: "tool_result", text: "t" }] }] }, stream: false, credentials: { copilotToken: "c" } });
    expect(out.url).toBe(PROVIDERS.github.baseUrl);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content[0]).toEqual({ type: "text", text: "t" });
  });

  it("400 'not supported' escalates to /responses, translates SSE (incl. split chunks) and caches the route", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(400, { error: { message: "The requested model is not supported" } }))
      .mockResolvedValueOnce(sseRes([
        'data: {"type":"response.created","response":{"id":"r1"}}\n\ndata: {"type":"response.output_text.del',
        'ta","delta":"Hel',
        'lo"}\n\n',
        "data: not-json\n\n",
        "data: [DONE]\n\n",
      ]))
      .mockResolvedValueOnce(sseRes(["data: [DONE]\n\n"]));
    const ex = new GithubExecutor();
    const log = { debug: vi.fn(), warn: vi.fn() };
    const out = await ex.execute({ model: "gpt-5-codex", body: { messages: [{ role: "user", content: "hi" }] }, stream: true, credentials: { copilotToken: "c" }, log });
    expect(out.url).toBe(PROVIDERS.github.responsesUrl);
    const text = await out.response.text();
    expect(text).toContain("Hello");
    expect(text).toContain("[DONE]");
    expect(ex.knownCodexModels.has("gpt-5-codex")).toBe(true);
    await ex.execute({ model: "gpt-5-codex", body: { messages: [] }, stream: true, credentials: { copilotToken: "c" }, log });
    expect(fetchMock.mock.calls[2][0]).toBe(PROVIDERS.github.responsesUrl);
  });

  it("400 for a gemini model is returned as-is, never escalated (#1062)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(400, "The requested model is not supported"));
    const out = await new GithubExecutor().execute({ model: "gemini-2.5-pro", body: { messages: [] }, stream: false, credentials: { copilotToken: "c" } });
    expect(out.response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("/responses upstream error is passed through untranslated", async () => {
    const ex = new GithubExecutor();
    ex.knownCodexModels.add("gpt-5-codex");
    fetchMock.mockResolvedValueOnce(jsonRes(500, { error: "boom" }));
    const out = await ex.execute({ model: "gpt-5-codex", body: { messages: [] }, stream: true, credentials: { copilotToken: "c" } });
    expect(out.response.status).toBe(500);
  });

  it("claude model goes to /v1/messages, strips _toolNameMap and translates Claude SSE to OpenAI chunks", async () => {
    fetchMock.mockResolvedValueOnce(sseRes([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4","usage":{"input_tokens":3}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi th',
      'ere"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'data: {"type":"message_stop"}',
    ]));
    const out = await new GithubExecutor().execute({
      model: "claude-sonnet-4",
      body: { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }] },
      stream: true,
      credentials: { copilotToken: "c" },
    });
    expect(out.url).toBe(PROVIDERS.github.messagesUrl);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent._toolNameMap).toBeUndefined();
    expect(sent.stream).toBe(true);
    const text = await out.response.text();
    expect(text).toContain("Hi there");
  });

  it("/v1/messages error response is returned without a transform", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(401, { error: "bad" }));
    const out = await new GithubExecutor().execute({ model: "claude-sonnet-4", body: { messages: [{ role: "user", content: "x" }] }, stream: false, credentials: { copilotToken: "c" } });
    expect(out.response.status).toBe(401);
  });
});

describe("GithubExecutor token refresh", () => {
  it("refreshes copilot token with `token <gh>` auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { token: "cop", expires_at: 123 }));
    const out = await new GithubExecutor().refreshCredentials({ accessToken: "gh", refreshToken: "r" });
    expect(out).toEqual({ accessToken: "gh", refreshToken: "r", copilotToken: "cop", copilotTokenExpiresAt: 123 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("token gh");
  });

  it("falls back to GitHub refresh_token grant, then retries copilot token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, "expired"))
      .mockResolvedValueOnce(jsonRes(200, { access_token: "gh2", expires_in: 10 }))
      .mockResolvedValueOnce(jsonRes(200, { token: "cop2", expires_at: 9 }));
    const out = await new GithubExecutor().refreshCredentials({ accessToken: "gh", refreshToken: "r" }, { error: vi.fn(), info: vi.fn() });
    expect(out).toEqual({ accessToken: "gh2", refreshToken: "r", expiresIn: 10, copilotToken: "cop2", copilotTokenExpiresAt: 9 });
  });

  it("returns github tokens when copilot still fails after refresh; null when everything fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, "x"))
      .mockResolvedValueOnce(jsonRes(200, { access_token: "gh2", refresh_token: "r2" }))
      .mockResolvedValueOnce(jsonRes(403, "x"));
    expect(await new GithubExecutor().refreshCredentials({ accessToken: "gh", refreshToken: "r" })).toEqual({ accessToken: "gh2", refreshToken: "r2", expiresIn: undefined });

    fetchMock.mockReset();
    fetchMock.mockReturnValue(new Error("offline"));
    const log = { error: vi.fn(), info: vi.fn() };
    expect(await new GithubExecutor().refreshCredentials({ accessToken: "gh-secret", refreshToken: "rt-secret" }, log)).toBeNull();
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("gh-secret");
    expect(logged).not.toContain("rt-secret");
  });

  it("needsRefresh: missing token, near expiry (seconds / ISO), fresh", () => {
    const ex = new GithubExecutor();
    expect(ex.needsRefresh({})).toBe(true);
    expect(ex.needsRefresh({ copilotToken: "c", copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 60 })).toBe(true);
    expect(ex.needsRefresh({ copilotToken: "c", copilotTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
    expect(ex.needsRefresh({ copilotToken: "c", copilotTokenExpiresAt: Date.now() + 3_600_000 })).toBe(false);
  });
});
