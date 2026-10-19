// Follow-ups to the streaming-usage changes:
// - strict upstreams that reject stream_options still stream (retry + remember),
//   also inside a combo, and nodes can opt out;
// - stream:true clients get SSE in their own format when the upstream answers JSON;
// - a held finish chunk is released after a bounded wait;
// - passthrough emits a single [DONE];
// - /v1/responses streams carry the client context buffer on response.completed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const { requestStreamUsage, forgetStreamUsageRejections, isStreamUsageRejection } = await import("../../open-sse/translator/concerns/streamUsage.js");
const { jsonResponseToSSE } = await import("../../open-sse/handlers/chatCore/jsonToSSE.js");
const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
const base = { id: "chatcmpl-fake-0001", object: "chat.completion.chunk", created: 1700000000, model: "fake-model" };
const sseOf = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const completionJson = () => ({
  id: "chatcmpl-fake-0001", object: "chat.completion", created: 1700000000, model: "fake-model",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: USAGE,
});

// Rejects stream_options like a strict (extra_forbidden) validator; otherwise
// streams with usage on the finish chunk.
function strictUpstream(_url, init) {
  const body = JSON.parse(init.body);
  if (body.stream_options) {
    return new Response(JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "stream_options"], msg: "Extra inputs are not permitted" }] }), { status: 422, headers: { "content-type": "application/json" } });
  }
  return new Response(sseOf([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE },
  ]), { headers: { "content-type": "text/event-stream" } });
}

const jsonUpstream = () => new Response(JSON.stringify(completionJson()), { headers: { "content-type": "application/json" } });

async function run({ body = {}, provider = "openai-compatible-chat-strict", credentials, sourceFormatOverride } = {}) {
  const fullBody = { model: "fake-model", messages: [{ role: "user", content: "hi" }], stream: true, ...body };
  const result = await handleChatCore({
    body: fullBody,
    modelInfo: { provider, model: "fake-model" },
    credentials: credentials || { apiKey: "sk-test-fake", providerSpecificData: { baseUrl: "http://strict.test/v1" } },
    clientRawRequest: { endpoint: "/v1/chat/completions", body: fullBody, headers: {} },
    connectionId: "conn-test",
    sourceFormatOverride,
  });
  const text = result.response ? await result.response.text() : "";
  await new Promise((r) => setTimeout(r, 0));
  return { result, text };
}

beforeEach(() => {
  fetchMock.mockReset();
  saveRequestUsage.mockClear();
  forgetStreamUsageRejections();
});

describe("strict upstream that rejects stream_options", () => {
  it("retries once without the field, streams, and remembers the node", async () => {
    fetchMock.mockImplementation(strictUpstream);
    const { result, text } = await run();
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("Hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saveRequestUsage.mock.calls.at(-1)[0].tokens).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });

    // Second request: remembered, no failed attempt first.
    fetchMock.mockClear();
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream_options).toBeUndefined();
  });

  it("does not retry a 4xx that has nothing to do with stream_options", async () => {
    fetchMock.mockImplementation(() => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors a node/connection opt-out", () => {
    const body = { messages: [] };
    expect(requestStreamUsage(body, "openai-compatible-chat-x", FORMATS.OPENAI, true, { providerSpecificData: { streamUsage: false } })).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it("only treats 400/422 errors that mention the field as rejections", async () => {
    expect(await isStreamUsageRejection(new Response("unknown field stream_options", { status: 400 }))).toBe(true);
    expect(await isStreamUsageRejection(new Response("include_usage not allowed", { status: 422 }))).toBe(true);
    expect(await isStreamUsageRejection(new Response("stream_options", { status: 500 }))).toBe(false);
    expect(await isStreamUsageRejection(new Response("rate limited", { status: 400 }))).toBe(false);
    expect(await isStreamUsageRejection(new Response("ok", { status: 200 }))).toBe(false);
  });
});

describe("stream:true client, upstream answers JSON", () => {
  it("OpenAI chat client gets chat.completion.chunk SSE ending in [DONE]", async () => {
    fetchMock.mockImplementation(jsonUpstream);
    const { result, text } = await run({ provider: "openai-compatible-chat-json" });
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    expect(chunks.map((c) => c.choices[0].delta.content || "").join("")).toBe("Hello");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it("Claude client gets Messages SSE events", async () => {
    fetchMock.mockImplementation(jsonUpstream);
    const { result, text } = await run({
      provider: "openai-compatible-chat-json",
      body: { system: "be brief", max_tokens: 64 },
      sourceFormatOverride: FORMATS.CLAUDE,
    });
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const types = text.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    expect(types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(text).toContain('"text":"Hello"');
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it("Responses client gets Responses SSE ending in response.completed", async () => {
    fetchMock.mockImplementation(jsonUpstream);
    const { result, text } = await run({
      provider: "openai-compatible-chat-json",
      body: { messages: undefined, input: "hi" },
      sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
    });
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const types = text.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types.at(-1)).toBe("response.completed");
    expect(saveRequestUsage).toHaveBeenCalledTimes(1);
  });

  it("covers Claude thinking/tool_use blocks and Responses non-message items", () => {
    const claude = jsonResponseToSSE({
      id: "msg_1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "tool_use", id: "tu_1", name: "lookup", input: { q: 1 } },
        { type: "redacted_thinking", data: "x" },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    }, FORMATS.CLAUDE);
    expect(claude).toContain("thinking_delta");
    expect(claude).toContain("signature_delta");
    expect(claude).toContain('"partial_json":"{\\"q\\":1}"');
    expect(claude).toContain("redacted_thinking");

    const chat = jsonResponseToSSE({
      id: "c", created: 1, model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "r", tool_calls: [{ id: "t", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    }, FORMATS.OPENAI);
    expect(chat).toContain('"reasoning_content":"r"');
    expect(chat).toContain('"tool_calls":[{"index":0');

    const responses = jsonResponseToSSE({ id: "r", object: "response", output: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }] }, FORMATS.OPENAI_RESPONSES);
    expect(responses).toContain("response.output_item.done");
    expect(jsonResponseToSSE({}, FORMATS.GEMINI)).toBeNull();
  });
});

describe("passthrough stream", () => {
  afterEach(() => vi.useRealTimers());

  async function pump(stream) {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const out = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(new TextDecoder().decode(value));
      }
    })();
    return { writer, out, reading, write: (s) => writer.write(new TextEncoder().encode(s)) };
  }

  it("releases a held finish chunk after the bounded wait when the trailer stalls", async () => {
    vi.useFakeTimers();
    const ts = createPassthroughStreamWithLogger("p", null, "m", "c", { messages: [] }, null, null, { awaitTrailer: true, dropTrailer: true });
    const { writer, out, reading, write } = await pump(ts);
    await write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n`);
    await write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    await vi.advanceTimersByTimeAsync(10);
    expect(out.join("")).not.toContain("finish_reason\":\"stop");
    await vi.advanceTimersByTimeAsync(3000);
    expect(out.join("")).toContain("finish_reason\":\"stop");
    // A late trailer is still dropped for this client.
    await write(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}\n\n`);
    await write("data: [DONE]\n\n");
    await writer.close();
    await reading;
    const text = out.join("");
    expect(text).not.toContain('"choices":[]');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("folds a trailer that arrives without a trailing newline", async () => {
    const onComplete = vi.fn();
    const ts = createPassthroughStreamWithLogger("p", null, "m", "c", { messages: [] }, onComplete, null, { awaitTrailer: true, dropTrailer: true });
    const { writer, out, reading, write } = await pump(ts);
    await write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\n`);
    await write(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}`);
    await writer.close();
    await reading;
    const text = out.join("");
    expect(text).not.toContain('"choices":[]');
    expect(onComplete.mock.calls[0][1]).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("emits a single [DONE] when the upstream sends its own", async () => {
    const ts = createPassthroughStreamWithLogger("p", null, "m", "c", { messages: [] });
    const { writer, out, reading, write } = await pump(ts);
    await write(sseOf([{ ...base, choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }], usage: USAGE }]));
    await writer.close();
    await reading;
    expect(out.join("").match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("/v1/responses streaming usage", () => {
  it("adds the context buffer to the client copy only", async () => {
    fetchMock.mockImplementation(() => new Response(sseOf([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage: USAGE },
    ]), { headers: { "content-type": "text/event-stream" } }));
    const { text } = await run({
      provider: "openai-compatible-chat-resp",
      body: { messages: undefined, input: "hi" },
      sourceFormatOverride: FORMATS.OPENAI_RESPONSES,
    });
    const completed = text.split("\n\n").find((b) => b.startsWith("event: response.completed"));
    const data = JSON.parse(completed.split("\ndata: ")[1]);
    expect(data.response.usage).toMatchObject({ input_tokens: 11 + 2000, output_tokens: 7 });
    expect(saveRequestUsage.mock.calls.at(-1)[0].tokens).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });
});
