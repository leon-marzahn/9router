// A combo whose first model sits behind a strict upstream (rejects
// stream_options) must answer from that model, not fall through to the next
// one with the 422. Real handleChat + real handleChatCore; upstream is mocked.
import { describe, expect, it, vi } from "vite-plus/test";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (provider, excluded) => (excluded.has(`${provider}-a1`) ? null : {
    connectionId: `${provider}-a1`, connectionName: "a1", apiKey: "sk-test-fake",
    providerSpecificData: { baseUrl: `http://${provider}.test/v1` },
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (m) => ({ provider: m.slice(0, m.indexOf("/")), model: m.slice(m.indexOf("/") + 1) })),
  getComboModels: vi.fn(async (m) => (m === "mycombo" ? ["openai-compatible-chat-strict/m1", "openai-compatible-chat-other/m2"] : null)),
  stripComboPrefix: (m) => m,
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

const { handleChat } = await import("../../src/sse/handlers/chat.js");

describe("combo with a strict first upstream", () => {
  it("streams from the first model instead of falling back on the 422", async () => {
    const base = { id: "chatcmpl-fake-0001", object: "chat.completion.chunk", created: 1, model: "m1" };
    fetchMock.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.stream_options) {
        return new Response(JSON.stringify({ detail: [{ loc: ["body", "stream_options"], msg: "Extra inputs are not permitted" }] }), { status: 422, headers: { "content-type": "application/json" } });
      }
      const text = [
        { ...base, choices: [{ index: 0, delta: { content: `from ${new URL(url).host}` }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    });

    const res = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mycombo", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("from openai-compatible-chat-strict.test");
    const hosts = fetchMock.mock.calls.map(([url]) => new URL(url).host);
    expect(hosts.every((h) => h === "openai-compatible-chat-strict.test")).toBe(true);
  });
});
