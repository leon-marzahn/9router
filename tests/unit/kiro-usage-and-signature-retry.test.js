// Kiro: signature-retry in execute(), credits on the Claude path, usage on reasoning+tool-call turns.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { translateResponse, initState } = await import("../../open-sse/translator/index.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { extractUsage, filterUsageForFormat } = await import("../../open-sse/utils/usageTracking.js");
await import("../translator/registerAll.js");

const enc = new TextEncoder();
function crc32(b) { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function frame(type, payload) {
  const name = enc.encode(":event-type"), val = enc.encode(type), body = enc.encode(JSON.stringify(payload));
  const hl = 1 + name.length + 1 + 2 + val.length, total = 12 + hl + body.length + 4;
  const f = new Uint8Array(total), v = new DataView(f.buffer);
  v.setUint32(0, total); v.setUint32(4, hl);
  let o = 12; f[o++] = name.length; f.set(name, o); o += name.length; f[o++] = 7; v.setUint16(o, val.length); o += 2; f.set(val, o); o += val.length; f.set(body, o);
  v.setUint32(8, crc32(f.subarray(0, 8))); v.setUint32(total - 4, crc32(f.subarray(0, total - 4)));
  return f;
}
const eventResponse = (frames) => new Response(new ReadableStream({ start(c) { frames.forEach((f) => c.enqueue(f)); c.close(); } }), { status: 200 });
const history = () => [
  { userInputMessage: { content: "q", modelId: "m" } },
  { assistantResponseMessage: { content: "a", reasoningContent: { reasoningText: { text: "t", signature: "SIG" } } } },
];
const run = (body, stream = false) => new KiroExecutor().execute({
  model: "kr/claude-sonnet-5.5", body, stream, credentials: { accessToken: "x", providerSpecificData: {} },
});
const okStream = () => eventResponse([frame("assistantResponseEvent", { content: "hi" })]);

beforeEach(() => fetchMock.mockReset());

describe("signature retry", () => {
  it("resends once without reasoningContent on THINKING_SIGNATURE_INVALID", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"message":"bad","reason":"THINKING_SIGNATURE_INVALID"}', { status: 400 }))
      .mockResolvedValueOnce(okStream());
    const body = { conversationState: { history: history(), currentMessage: { userInputMessage: { content: "n", modelId: "m" } } } };
    const { response } = await run(body);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).conversationState.history[1].assistantResponseMessage.reasoningContent).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).conversationState.history[1].assistantResponseMessage.reasoningContent).toBeUndefined();
  });

  it("retries only once when the second attempt is also a signature 400", async () => {
    fetchMock.mockImplementation(async () => new Response('{"reason":"THINKING_SIGNATURE_INVALID"}', { status: 400 }));
    const body = { conversationState: { history: history(), currentMessage: { userInputMessage: { content: "n", modelId: "m" } } } };
    const { response } = await run(body);
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when there is no reasoning in history", async () => {
    fetchMock.mockResolvedValue(new Response('{"reason":"THINKING_SIGNATURE_INVALID"}', { status: 400 }));
    const h = history(); delete h[1].assistantResponseMessage.reasoningContent;
    await run({ conversationState: { history: h, currentMessage: { userInputMessage: { content: "n", modelId: "m" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns other 400s unretried with the body intact", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"other"}', { status: 400 }));
    const body = { conversationState: { history: history(), currentMessage: { userInputMessage: { content: "n", modelId: "m" } } } };
    const { response } = await run(body);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("other");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("upstream error after partial output on the Claude path", () => {
  it("emits an error event instead of a clean end_turn", () => {
    const state = initState(FORMATS.CLAUDE);
    const base = { id: "chatcmpl-x1234567", model: "kiro" };
    const out = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hmm" }, finish_reason: null }] },
      { error: { message: "Kiro ended with non-success stop reason: content_filtered", code: "kiro_terminal_refusal" } },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "error" }] },
    ].flatMap((c) => translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, c, state) || []);
    const err = out.find((e) => e.type === "error");
    expect(err.error.message).toContain("content_filtered");
    expect(out.some((e) => e.type === "message_delta" || e.type === "message_stop")).toBe(false);
  });
});

describe("credits on the Claude path", () => {
  it("survives kiro-to-claude into the message_delta usage", () => {
    const state = initState(FORMATS.CLAUDE);
    const usage = { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, credits: 0.25 };
    const out = [
      { id: "chatcmpl-x1234567", model: "kiro", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { id: "chatcmpl-x1234567", model: "kiro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ].flatMap((c) => translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, c, state) || []);
    const delta = out.find((e) => e.type === "message_delta");
    expect(extractUsage(delta).credits).toBe(0.25);
    expect(extractUsage(delta).completion_tokens).toBe(7);
  });

  it("reports input_tokens without cache so clients don't double-count it", () => {
    const state = initState(FORMATS.CLAUDE);
    const usage = { prompt_tokens: 65000, completion_tokens: 7, total_tokens: 65007, prompt_tokens_details: { cached_tokens: 60000 } };
    const out = [
      { id: "chatcmpl-x1234567", model: "kiro", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { id: "chatcmpl-x1234567", model: "kiro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ].flatMap((c) => translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, c, state) || []);
    const u = out.find((e) => e.type === "message_delta").usage;
    expect(u.input_tokens + u.cache_read_input_tokens + (u.cache_creation_input_tokens || 0)).toBe(65000);
  });
});

describe("usage on a reasoning + tool-call turn (OpenAI route)", () => {
  const events = {
    reasoning: frame("reasoningContentEvent", { content: "thinking" }),
    tool: frame("toolUseEvent", { toolUseId: "t1", name: "run_calc", input: '{"expr":"1+1"}', stop: true }),
    ctx: frame("contextUsageEvent", { contextUsagePercentage: 1.5 }),
    meter: frame("meteringEvent", { unit: "credit", usage: 0.07 }),
  };
  const lastUsage = async (order) => {
    const res = new KiroExecutor().transformEventStreamToSSE(eventResponse(order.map((k) => events[k])), "kr/claude-sonnet-5.5", {});
    const chunks = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    return chunks.filter((c) => c.usage).at(-1)?.usage;
  };
  it("forwards a signature-only frame as reasoning_signature", async () => {
    const res = new KiroExecutor().transformEventStreamToSSE(eventResponse([frame("reasoningContentEvent", { signature: "SIG" }), events.tool]), "kr/claude-sonnet-5", {});
    const deltas = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta || {});
    expect(deltas.some((d) => d.reasoning_signature === "SIG")).toBe(true);
    expect(deltas.some((d) => d.reasoning_content)).toBe(false);
  });
  it("emits the signature after the reasoning text of the same frame", async () => {
    const f = frame("reasoningContentEvent", { text: "why", signature: "SIG" });
    const res = new KiroExecutor().transformEventStreamToSSE(eventResponse([f, events.tool]), "kr/claude-sonnet-5.5", {});
    const deltas = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta || {});
    const keys = deltas.flatMap((d) => Object.keys(d)).filter((k) => k.startsWith("reasoning"));
    expect(keys).toEqual(["reasoning_content", "reasoning_signature"]);
  });
  it("does not report 0 prompt tokens when context usage is 0%", async () => {
    const res = new KiroExecutor().transformEventStreamToSSE(
      eventResponse([events.reasoning, events.tool, frame("contextUsageEvent", { contextUsagePercentage: 0 })]), "kr/claude-sonnet-5.5", {});
    const chunks = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.filter((c) => c.usage).at(-1)?.usage?.prompt_tokens ?? 0).toBe(0);
  });
  it("keeps credits when Kiro sends metering but no context usage", async () => {
    expect((await lastUsage(["reasoning", "tool", "meter"]))?.credits).toBe(0.07);
  });
  it("derives prompt tokens when Kiro sends context usage but no metering", async () => {
    expect((await lastUsage(["reasoning", "tool", "ctx"]))?.prompt_tokens).toBeGreaterThan(0);
  });
  for (const order of [["reasoning", "tool", "ctx", "meter"], ["reasoning", "tool", "meter", "ctx"], ["ctx", "meter", "reasoning", "tool"]]) {
    it(`reports prompt tokens and credits for ${order.join(",")}`, async () => {
      const usage = await lastUsage(order);
      expect(usage?.prompt_tokens).toBeGreaterThan(0);
      expect(usage?.credits).toBe(0.07);
    });
  }
});

describe("non-streaming client usage", () => {
  it("keeps Kiro credits on the OpenAI-format body", () => {
    const usage = filterUsageForFormat({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 0.07, credit_unit: "credit" }, FORMATS.OPENAI);
    expect(usage).toMatchObject({ prompt_tokens: 10, credits: 0.07, credit_unit: "credit" });
  });

  const completion = (usage) => ({
    id: "c1", model: "m", usage,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  });

  it("reports cache on a Claude message with input_tokens excluding it", () => {
    const out = translateNonStreamingResponse(completion({
      prompt_tokens: 103000, completion_tokens: 640,
      prompt_tokens_details: { cached_tokens: 98000, cache_creation_tokens: 1912 },
    }), FORMATS.KIRO, FORMATS.CLAUDE);
    expect(out.usage).toEqual({
      input_tokens: 3088, output_tokens: 640,
      cache_read_input_tokens: 98000, cache_creation_input_tokens: 1912,
    });
  });

  it("omits the cache keys when the upstream reported none", () => {
    const out = translateNonStreamingResponse(completion({ prompt_tokens: 500, completion_tokens: 20 }), FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(out.usage).toEqual({ input_tokens: 500, output_tokens: 20 });
  });

  it("keeps cache through the client-facing Claude usage filter", () => {
    const out = translateNonStreamingResponse(completion({
      prompt_tokens: 90, completion_tokens: 4, cache_read_input_tokens: 80,
    }), FORMATS.KIRO, FORMATS.CLAUDE);
    expect(filterUsageForFormat(out.usage, FORMATS.CLAUDE)).toMatchObject({
      input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 80,
    });
  });
});

describe("non-streaming reasoning signature", () => {
  const sse = [
    { id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "why" } }] },
    { id: "c1", model: "m", choices: [{ index: 0, delta: { reasoning_signature: "SIG" } }] },
    { id: "c1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] } }] },
    { id: "c1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

  it("aggregates the signature from the SSE body", () => {
    const msg = parseSSEToOpenAIResponse(sse, "m").choices[0].message;
    expect(msg).toMatchObject({ reasoning_content: "why", reasoning_signature: "SIG" });
  });
  it("keeps a signature-only turn (no thinking text)", () => {
    const only = sse.replace('"reasoning_content":"why"', '"content":""');
    const msg = parseSSEToOpenAIResponse(only, "m").choices[0].message;
    expect(msg.reasoning_signature).toBe("SIG");
  });
  it("turns a kiro-target body into a Claude message with a signed thinking block", () => {
    const body = parseSSEToOpenAIResponse(sse, "m");
    const out = translateNonStreamingResponse(body, FORMATS.KIRO, FORMATS.CLAUDE);
    expect(out.type).toBe("message");
    expect(out.content[0]).toEqual({ type: "thinking", thinking: "why", signature: "SIG" });
    expect(out.content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });
});
