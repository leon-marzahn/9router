// Regression: requests that omitted `stream` recorded no usage row. chatCore
// treated an absent `stream` as streaming, forwarded the body without it, got a
// JSON chat.completion back and piped it through the SSE transform, which saw
// no `data:` lines (no usage, JSON labeled text/event-stream).
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

const { handleChatCore, resolveClientStreamIntent, syncUpstreamStreamFlag, probeJsonUpstream } = await import("../../open-sse/handlers/chatCore.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function completionJson() {
  return {
    id: "chatcmpl-fake-0001",
    object: "chat.completion",
    created: 1700000000,
    model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: USAGE,
  };
}

function sse(includeUsageChunk) {
  const base = { id: "chatcmpl-fake-0001", object: "chat.completion.chunk", created: 1700000000, model: "fake-model" };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
    includeUsageChunk
      ? { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      : { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE },
  ];
  if (includeUsageChunk) chunks.push({ ...base, choices: [], usage: USAGE });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

// Upstream that honors `stream` (and stream_options.include_usage, if sent).
function honoringUpstream(_url, init) {
  const body = JSON.parse(init.body);
  if (body.stream === true) {
    const usageChunk = body.stream_options?.include_usage === true;
    return new Response(sse(usageChunk), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(completionJson()), { headers: { "content-type": "application/json" } });
}

// Upstream that ignores `stream` and always answers JSON.
function jsonUpstream() {
  return new Response(JSON.stringify(completionJson()), { headers: { "content-type": "application/json" } });
}

async function run({ body, accept, provider = "openai-compatible-chat-fake" }) {
  const headers = accept ? { accept } : {};
  const result = await handleChatCore({
    body: { model: "fake-model", messages: [{ role: "user", content: "hi" }], ...body },
    modelInfo: { provider, model: "fake-model" },
    credentials: { apiKey: "sk-test-fake", providerSpecificData: { baseUrl: "http://upstream.test/v1" } },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
    connectionId: "conn-test",
    apiKey: "sk-client-test",
  });
  expect(result.success).toBe(true);
  const text = await result.response.text(); // drain so stream finalizers run
  await new Promise((r) => setTimeout(r, 0));
  return { response: result.response, text };
}

const upstreamBody = () => JSON.parse(fetchMock.mock.calls.at(-1)[1].body);

beforeEach(() => {
  fetchMock.mockReset();
  saveRequestUsage.mockClear();
});

describe("usage row for every stream-intent case", () => {
  const cases = [
    { name: "stream omitted, no Accept", body: {}, expectSSE: false },
    { name: "stream:false", body: { stream: false }, expectSSE: false },
    { name: "stream:true", body: { stream: true }, expectSSE: true },
    { name: "stream omitted, Accept: application/json", body: {}, accept: "application/json", expectSSE: false },
    { name: "stream omitted, Accept: text/event-stream", body: {}, accept: "text/event-stream", expectSSE: true },
  ];

  it.each(cases)("stream-honoring upstream: $name", async ({ body, accept, expectSSE }) => {
    fetchMock.mockImplementation(honoringUpstream);
    const { response } = await run({ body, accept });
    expect(response.headers.get("content-type")).toContain(expectSSE ? "text/event-stream" : "application/json");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it.each(cases)("always-JSON upstream: $name", async ({ body, accept }) => {
    fetchMock.mockImplementation(jsonUpstream);
    const { response, text } = await run({ body, accept });
    // A JSON upstream can only produce JSON; it must be labeled as such.
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it("forceStream provider: stream omitted still sends stream:true upstream and returns aggregated JSON", async () => {
    fetchMock.mockImplementation(honoringUpstream);
    const { response, text } = await run({ body: {}, provider: "openai" });
    expect(upstreamBody().stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(text).choices[0].message.content).toBe("Hello");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
    expect(saveRequestUsage.mock.calls[0][0].tokens).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it("does not send stream to the upstream when the client omitted it", async () => {
    fetchMock.mockImplementation(honoringUpstream);
    await run({ body: {} });
    expect(upstreamBody().stream).toBeUndefined();
  });
});

describe("resolveClientStreamIntent", () => {
  it("defaults body-field formats to non-streaming", () => {
    for (const f of [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]) {
      expect(resolveClientStreamIntent({}, f)).toBe(false);
      expect(resolveClientStreamIntent({ stream: true }, f)).toBe(true);
      expect(resolveClientStreamIntent({ stream: false }, f, { accept: "text/event-stream" })).toBe(false);
    }
  });

  it("keeps Gemini-family wires streaming", () => {
    for (const f of [FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY]) {
      expect(resolveClientStreamIntent({}, f)).toBe(true);
    }
  });

  it("treats an SSE-only Accept header as a stream request", () => {
    expect(resolveClientStreamIntent({}, FORMATS.OPENAI, { accept: "text/event-stream" })).toBe(true);
    expect(resolveClientStreamIntent({}, FORMATS.OPENAI, { accept: "application/json, text/event-stream" })).toBe(false);
  });
});

describe("syncUpstreamStreamFlag", () => {
  it("sets stream:true on body-field wires when streaming", () => {
    expect(syncUpstreamStreamFlag({}, FORMATS.CLAUDE, true).stream).toBe(true);
    expect(syncUpstreamStreamFlag({}, FORMATS.OPENAI, true).stream).toBe(true);
  });

  it("leaves Gemini bodies alone (stream is in the URL)", () => {
    expect(syncUpstreamStreamFlag({}, FORMATS.GEMINI, true).stream).toBeUndefined();
  });

  it("drops stream_options from a non-streaming OpenAI body", () => {
    expect(syncUpstreamStreamFlag({ stream_options: { include_usage: true } }, FORMATS.OPENAI, false)).toEqual({});
  });
});

describe("probeJsonUpstream", () => {
  it("passes SSE-labeled responses through untouched", async () => {
    const res = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    const probed = await probeJsonUpstream(res);
    expect(probed.isJson).toBe(false);
    expect(probed.response).toBe(res);
  });

  it("replays SSE mislabeled as application/json", async () => {
    const res = new Response("data: {\"a\":1}\n\ndata: [DONE]\n\n", { headers: { "content-type": "application/json" } });
    const probed = await probeJsonUpstream(res);
    expect(probed.isJson).toBe(false);
    expect(await probed.response.text()).toBe("data: {\"a\":1}\n\ndata: [DONE]\n\n");
  });

  it("detects a JSON document and replays it", async () => {
    const res = new Response(JSON.stringify(completionJson()), { headers: { "content-type": "application/json" } });
    const probed = await probeJsonUpstream(res);
    expect(probed.isJson).toBe(true);
    expect((await probed.response.json()).usage).toEqual(USAGE);
  });

  it("does not treat NDJSON as a single JSON document", async () => {
    const res = new Response("{\"a\":1}\n{\"b\":2}\n", { headers: { "content-type": "application/json" } });
    const probed = await probeJsonUpstream(res);
    expect(probed.isJson).toBe(false);
  });
});
