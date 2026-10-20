// Regression: Gemini non-streaming :generateContent dropped the reasoning text
// (thought parts) while :streamGenerateContent included it. chatCore stripped
// reasoning_content from answered non-streaming responses for every client; the
// /v1beta route then had nothing to turn into a `thought: true` part.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { stripAnsweredReasoning, clientKeepsReasoning } = await import("../../open-sse/handlers/chatCore/reasoning.js");

const completion = () => ({
  id: "chatcmpl-fake", object: "chat.completion", created: 1700000000, model: "fake-model",
  choices: [{ index: 0, message: { role: "assistant", content: "ANSWER", reasoning_content: "THINKING" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
});

async function nonStream(endpoint) {
  const body = { model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: false };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "openai-compatible-chat-fake", model: "fake-model" },
    credentials: { apiKey: "sk-test-fake", providerSpecificData: { baseUrl: "http://fake.test/v1" } },
    clientRawRequest: { endpoint, body, headers: {} },
    connectionId: "conn-test",
  });
  return result.response.json();
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(completion()), { headers: { "content-type": "application/json" } }));
});

describe("non-streaming reasoning_content", () => {
  it("is kept for the Gemini-native route, so it becomes a thought part", async () => {
    const json = await nonStream("/v1beta/models/fake/fake-model:generateContent");
    expect(json.choices[0].message).toMatchObject({ content: "ANSWER", reasoning_content: "THINKING" });
  });

  it("is still stripped for OpenAI chat clients when there is an answer", async () => {
    const json = await nonStream("/v1/chat/completions");
    expect(json.choices[0].message.content).toBe("ANSWER");
    expect(json.choices[0].message.reasoning_content).toBeUndefined();
  });
});

describe("stripAnsweredReasoning", () => {
  const choices = () => [
    { message: { content: "a", reasoning_content: "r" } },
    { message: { content: "", reasoning_content: "only" } },
  ];
  it("drops answered reasoning, keeps reasoning-only output", () => {
    const c = choices();
    stripAnsweredReasoning(c, "/v1/chat/completions");
    expect(c[0].message.reasoning_content).toBeUndefined();
    expect(c[1].message.reasoning_content).toBe("only");
  });
  it("keeps everything for Gemini-native endpoints and tolerates missing input", () => {
    const c = choices();
    stripAnsweredReasoning(c, "/v1beta/models/x:generateContent");
    expect(c[0].message.reasoning_content).toBe("r");
    expect(() => stripAnsweredReasoning(undefined, null)).not.toThrow();
    expect(clientKeepsReasoning(undefined)).toBe(false);
  });
});
