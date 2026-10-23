// A caller's client signal (fusion panel calls) aborts the upstream call when the client
// disconnects, so a fan-out does not keep paying for answers nobody will read.
import { describe, expect, it, vi } from "vite-plus/test";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

// Upstream that only answers when its request signal aborts (then rejects like fetch does).
function hangingUpstream() {
  fetchMock.mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    if (opts?.signal?.aborted) return fail();
    opts?.signal?.addEventListener("abort", fail, { once: true });
  }));
}

function call(clientSignal) {
  const body = { model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: false };
  return handleChatCore({
    body,
    modelInfo: { provider: "openai-compatible-chat-fake", model: "fake-model" },
    credentials: { apiKey: "sk-test-fake", providerSpecificData: { baseUrl: "http://fake.test/v1" } },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "conn-test",
    clientSignal,
  });
}

describe("handleChatCore clientSignal", () => {
  it("aborts the upstream call when the client disconnects (499)", async () => {
    hangingUpstream();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const t0 = Date.now();
    const result = await call(ctrl.signal);
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("an already-aborted signal aborts the upstream call too", async () => {
    hangingUpstream();
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await call(ctrl.signal);
    expect(result.status).toBe(499);
  });
});
