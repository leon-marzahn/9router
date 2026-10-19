// Streaming usage must be the upstream's real count, not an estimate plus the
// 2000-token context buffer. The gateway asks OpenAI-format upstreams for
// stream_options.include_usage, folds the usage-only trailer into the finish
// chunk, and hides the trailer from clients that did not ask for it.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fetchMock, saveRequestUsage } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage,
  trackPendingRequest: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: fetchMock,
  proxyAwareFetch: fetchMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { requestStreamUsage } = await import("../../open-sse/translator/concerns/streamUsage.js");
const { estimateUsage } = await import("../../open-sse/utils/usageTracking.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const base = { id: "chatcmpl-fake-0001", object: "chat.completion.chunk", created: 1700000000, model: "fake-model" };

// Honors stream_options.include_usage like the OpenAI API: usage only in a
// trailing `choices: []` chunk, and only when asked. Never sends usage otherwise.
function openAIStyleUpstream(_url, init) {
  const body = JSON.parse(init.body);
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello there" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  if (body.stream_options?.include_usage) chunks.push({ ...base, choices: [], usage: USAGE });
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

async function run({ body, provider = "openai-compatible-chat-fake", sourceFormatOverride }) {
  const fullBody = { model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: true, ...body };
  const result = await handleChatCore({
    body: fullBody,
    modelInfo: { provider, model: "fake-model" },
    credentials: { apiKey: "sk-test-fake", providerSpecificData: { baseUrl: "http://upstream.test/v1" } },
    clientRawRequest: { endpoint: "/v1/chat/completions", body: fullBody, headers: {} },
    connectionId: "conn-test",
    apiKey: "sk-client-test",
    sourceFormatOverride,
  });
  expect(result.success).toBe(true);
  const text = await result.response.text();
  await new Promise((r) => setTimeout(r, 0));
  const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
  return { text, events };
}

const upstreamBody = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
const recorded = () => saveRequestUsage.mock.calls.at(-1)[0].tokens;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(openAIStyleUpstream);
  saveRequestUsage.mockClear();
});

describe("OpenAI client, OpenAI-format upstream (passthrough)", () => {
  it("requests include_usage, records the real usage and hides the trailer", async () => {
    const { events } = await run({});
    expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(recorded()).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
    // No usage-only chunk for a client that did not ask for one.
    expect(events.some((e) => Array.isArray(e.choices) && e.choices.length === 0)).toBe(false);
    // The finish chunk still carries usage for the client (with the context buffer).
    const finish = events.find((e) => e.choices?.[0]?.finish_reason);
    expect(finish.usage).toMatchObject({ prompt_tokens: 11 + 2000, completion_tokens: 7 });
  });

  it("forwards the trailer when the client asked for it", async () => {
    const { events } = await run({ body: { stream_options: { include_usage: true } } });
    const trailer = events.find((e) => Array.isArray(e.choices) && e.choices.length === 0);
    expect(trailer.usage).toEqual(USAGE);
    expect(recorded()).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it("never asks a non-streaming upstream for stream usage", async () => {
    fetchMock.mockImplementation(() => new Response(JSON.stringify({
      id: "chatcmpl-fake-0001", object: "chat.completion", created: 1, model: "fake-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: USAGE,
    }), { headers: { "content-type": "application/json" } }));
    await run({ body: { stream: false } });
    expect(upstreamBody().stream_options).toBeUndefined();
  });
});

describe("client body stays untouched", () => {
  it("does not write stream/stream_options into the body the fallback loop re-sends", async () => {
    const body = { model: "fake-model", messages: [{ role: "user", content: "hi" }] };
    await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "fake-model" }, // forceStream provider
      credentials: { apiKey: "sk-test-fake" },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId: "conn-test",
    });
    expect(upstreamBody()).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(body.stream).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });
});

describe("estimates are recorded without the context buffer", () => {
  it("records a plain estimate when the provider opts out and sends no usage", async () => {
    const { events } = await run({ provider: "mistral" });
    expect(upstreamBody().stream_options).toBeUndefined();
    const fullBody = { model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: true };
    const expected = estimateUsage(fullBody, "Hello there".length, FORMATS.OPENAI);
    expect(recorded().prompt_tokens).toBe(expected.prompt_tokens);
    expect(recorded().prompt_tokens).toBeLessThan(2000);
    // The client still sees the buffered figure.
    const finish = events.find((e) => e.choices?.[0]?.finish_reason);
    expect(finish.usage.prompt_tokens).toBe(expected.prompt_tokens + 2000);
  });
});

describe("Claude client, OpenAI-format upstream (translated)", () => {
  it("records the real trailer usage instead of max(estimate, real)", async () => {
    await run({
      body: { system: "be brief", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      sourceFormatOverride: FORMATS.CLAUDE,
    });
    expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    expect(recorded()).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });
});

describe("requestStreamUsage", () => {
  it("adds include_usage only to streaming OpenAI bodies without stream_options", () => {
    const body = { messages: [] };
    expect(requestStreamUsage(body, "openai-compatible-chat-x", FORMATS.OPENAI, true)).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });

    expect(requestStreamUsage({ messages: [] }, "openai-compatible-chat-x", FORMATS.OPENAI, false)).toBe(false);
    expect(requestStreamUsage({ messages: [] }, "claude", FORMATS.CLAUDE, true)).toBe(false);
    const own = { messages: [], stream_options: { include_usage: false } };
    expect(requestStreamUsage(own, "openai-compatible-chat-x", FORMATS.OPENAI, true)).toBe(false);
    expect(own.stream_options).toEqual({ include_usage: false });
  });

  it("honors the registry opt-out quirk", () => {
    for (const provider of ["mistral", "cerebras"]) {
      const body = { messages: [] };
      expect(requestStreamUsage(body, provider, FORMATS.OPENAI, true)).toBe(false);
      expect(body.stream_options).toBeUndefined();
    }
  });
});
