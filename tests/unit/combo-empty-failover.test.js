// empty-content failover for combo streaming responses.
import { describe, it, expect, vi } from "vite-plus/test";
import {
  deltaHasClientContent,
  inspectSSELine,
  scanSSEBuffer,
  isNoRetryFinish,
  peekStreamForContent,
  reconstructStream,
} from "../../open-sse/services/emptyFailover.js";
import { NO_RETRY_EMPTY_FINISH } from "../../open-sse/translator/schema/finishReasons.js";

// The combo cases below build real streaming responses; keep request-detail writes off disk.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const enc = new TextEncoder();
const dec = new TextDecoder();

// Build a ReadableStream of encoded SSE frames. `delays[i]` (ms) optionally staggers frame i.
function sseStream(frames, delays = []) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= frames.length) { controller.close(); return; }
      const d = delays[i] || 0;
      if (d) await new Promise((r) => setTimeout(r, d));
      controller.enqueue(enc.encode(frames[i]));
      i++;
    },
  });
}

const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const EMPTY_STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30194,"completion_tokens":15}}\n\n`;
const CONTENT = `data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n`;
const DONE = `data: [DONE]\n\n`;
const FILTER_STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n`;
const REASONING = `data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n`;

describe("peek bounds and client abort", () => {
  // A stream whose reads are always ready (no awaits between frames) must still hit the
  // deadline: it is checked every iteration, not only when a read is slow.
  function endlessStream(frame, { onCancel } = {}) {
    const bytes = enc.encode(frame);
    return new ReadableStream({
      pull(controller) { controller.enqueue(bytes); },
      cancel() { onCancel?.(); },
    });
  }
  const KEEPALIVE = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n`;

  it("an always-ready content-less stream is committed at the byte cap, not buffered without bound", async () => {
    const p = await peekStreamForContent(endlessStream(KEEPALIVE), { deadlineMs: 60_000, maxBytes: 64 * 1024 });
    expect(p.outcome).toBe("content");
    expect(p.capped).toBe(true);
    const buffered = p.head.reduce((n, c) => n + c.byteLength, 0);
    expect(buffered).toBeGreaterThanOrEqual(64 * 1024);
    expect(buffered).toBeLessThan(64 * 1024 + 1024);
    p.reader.cancel().catch(() => {});
  });

  it("an always-ready stream cannot starve the deadline", async () => {
    const t0 = Date.now();
    const p = await peekStreamForContent(endlessStream(KEEPALIVE), { deadlineMs: 100, maxBytes: 1024 ** 3 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    p.reader.cancel().catch(() => {});
  });

  it("a long unterminated line is bounded by the byte cap", async () => {
    const p = await peekStreamForContent(endlessStream("x".repeat(4096)), { deadlineMs: 60_000, maxBytes: 256 * 1024 });
    expect(p.outcome).toBe("content");
    expect(p.capped).toBe(true);
    p.reader.cancel().catch(() => {});
  });

  it("maxBytes 0 / NaN is clamped to the default (the cap cannot be disabled)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE]), { maxBytes: 0 });
    expect(p.outcome).toBe("content");
    expect(p.capped).toBe(false);
  });

  it("a client abort during the peek ends it as 'aborted' and cancels the upstream body", async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    // Upstream that only sends a role frame and then hangs.
    const body = new ReadableStream({
      start(controller) { controller.enqueue(enc.encode(ROLE)); },
      cancel() { cancelled = true; },
    });
    setTimeout(() => ctrl.abort(), 20);
    const t0 = Date.now();
    const p = await peekStreamForContent(body, { deadlineMs: 10_000, signal: ctrl.signal });
    expect(p.outcome).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  it("an already-aborted signal ends the peek before reading", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE]), { signal: ctrl.signal });
    expect(p.outcome).toBe("aborted");
  });
});

describe("deltaHasClientContent", () => {
  it("role-only delta is NOT content", () => expect(deltaHasClientContent({ role: "assistant" })).toBe(false));
  it("empty string content is NOT content", () => expect(deltaHasClientContent({ content: "" })).toBe(false));
  it("reasoning_content is NOT content", () => expect(deltaHasClientContent({ reasoning_content: "x" })).toBe(false));
  it("non-empty string content IS content", () => expect(deltaHasClientContent({ content: "hi" })).toBe(true));
  it("content array IS content", () => expect(deltaHasClientContent({ content: [{ type: "text", text: "a" }] })).toBe(true));
  it("tool_calls IS content", () => expect(deltaHasClientContent({ tool_calls: [{ id: "1" }] })).toBe(true));
  it("null/garbage is NOT content", () => { expect(deltaHasClientContent(null)).toBe(false); expect(deltaHasClientContent("x")).toBe(false); });
});

describe("inspectSSELine", () => {
  it("[DONE] carries nothing", () => expect(inspectSSELine("data: [DONE]")).toMatchObject({ content: false, finishReason: null }));
  it("role frame: no content, no finish", () => {
    const r = inspectSSELine(ROLE.trim());
    expect(r.content).toBe(false); expect(r.finishReason).toBe(null);
  });
  it("empty stop frame: no content, finish stop", () => {
    const r = inspectSSELine(EMPTY_STOP.trim());
    expect(r.content).toBe(false); expect(r.finishReason).toBe("stop");
  });
  it("content frame: content true", () => expect(inspectSSELine(CONTENT.trim()).content).toBe(true));
  it("non-data lines are inert", () => {
    expect(inspectSSELine("event: ping").content).toBe(false);
    expect(inspectSSELine(": keep-alive").content).toBe(false);
  });
});

describe("scanSSEBuffer latches", () => {
  it("stays empty across role+stop", () => {
    const st = scanSSEBuffer(ROLE + EMPTY_STOP);
    expect(st.sawContent).toBe(false); expect(st.finishReason).toBe("stop");
  });
  it("latches content once seen", () => {
    const st = scanSSEBuffer(ROLE + CONTENT + EMPTY_STOP);
    expect(st.sawContent).toBe(true);
  });
});

describe("isNoRetryFinish", () => {
  it("content_filter → no retry", () => expect(isNoRetryFinish("content_filter")).toBe(true));
  it("stop → retry (false)", () => expect(isNoRetryFinish("stop")).toBe(false));
  it("null → false", () => expect(isNoRetryFinish(null)).toBe(false));
  it("schema set holds content_filter", () => expect(NO_RETRY_EMPTY_FINISH.has("content_filter")).toBe(true));
});

describe("peekStreamForContent", () => {
  it("MALFORMED-style empty stream → outcome empty, finish stop", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, EMPTY_STOP, DONE]));
    expect(p.outcome).toBe("empty");
    expect(p.finishReason).toBe("stop");
  });

  it("content stream → outcome content", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, EMPTY_STOP, DONE]));
    expect(p.outcome).toBe("content");
  });

  // Reasoning is not content, but it proves the stream is alive: the peek commits on the
  // first reasoning frame so thinking models stream to the client immediately.
  it("a reasoning frame commits the stream (alive), without waiting for content", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, REASONING, CONTENT, DONE], [0, 0, 5000]), { deadlineMs: 10_000 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(false);
    p.reader.cancel().catch(() => {});
  });

  it("content-filter empty → empty with content_filter reason (caller won't retry)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, FILTER_STOP, DONE]));
    expect(p.outcome).toBe("empty");
    expect(isNoRetryFinish(p.finishReason)).toBe(true);
  });

  it("deadline fail-open: slow first content → committed as content", async () => {
    // content frame delayed 200ms, deadline 30ms → must commit (not falsely fall through)
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE], [0, 200]), { deadlineMs: 30 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(true);
  });

  // Regression for C1: the deadline must NOT drop the in-flight chunk. Reconstruct + drain and
  // assert the delayed content actually reaches the client (previously it was silently lost).
  it("deadline hand-off preserves the delayed content frame end-to-end", async () => {
    const frames = [ROLE, CONTENT, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames, [0, 200]), { deadlineMs: 30 });
    expect(p.outcome).toBe("content");
    expect(p.timedOut).toBe(true);
    const rebuilt = reconstructStream(p.head, p.reader, p.pendingRead);
    const rd = rebuilt.getReader(); let out = "";
    while (true) { const { done, value } = await rd.read(); if (done) break; out += dec.decode(value); }
    expect(out).toBe(frames.join(""));           // no loss, no reorder
    expect(out).toContain('"content":"OK"');      // the slow frame survived
  });

  // Regression for M1: a zero/NaN deadline must NOT disable the timeout (no infinite hang).
  it("deadline=0 is clamped (does not hang on a normal stream)", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, EMPTY_STOP, DONE]), { deadlineMs: 0 });
    expect(p.outcome).toBe("empty");
  });
  it("deadline=NaN is clamped", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT, DONE]), { deadlineMs: NaN });
    expect(p.outcome).toBe("content");
  });
});

describe("partial lines", () => {
  it("never parses an incomplete trailing line (no parse warnings at chunk boundaries)", () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const half = CONTENT.slice(0, 30); // a data: line cut mid-JSON
    const st = scanSSEBuffer(ROLE + half);
    expect(st.sawContent).toBe(false);
    expect(st.pending).toBe(half);
    expect(warn).not.toHaveBeenCalled();
    scanSSEBuffer(st.pending + CONTENT.slice(30), st); // completed by the next chunk
    expect(st.sawContent).toBe(true);
    warn.mockRestore();
  });

  it("detects content on a final line that has no trailing newline", async () => {
    const p = await peekStreamForContent(sseStream([ROLE, CONTENT.trim()]));
    expect(p.outcome).toBe("content");
  });
});

describe("reconstructStream is byte-faithful", () => {
  async function drain(stream) {
    const rd = stream.getReader(); let out = "";
    while (true) { const { done, value } = await rd.read(); if (done) break; out += dec.decode(value); }
    return out;
  }

  it("content case replays head + remaining identically", async () => {
    const frames = [ROLE, CONTENT, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames));
    const rebuilt = reconstructStream(p.head, p.reader);
    expect(await drain(rebuilt)).toBe(frames.join(""));
  });

  it("empty case (fully buffered) replays identically", async () => {
    const frames = [ROLE, EMPTY_STOP, DONE];
    const p = await peekStreamForContent(sseStream(frames));
    const rebuilt = reconstructStream(p.head, p.reader);
    expect(await drain(rebuilt)).toBe(frames.join(""));
  });
});

// The peek reads the CLIENT-format stream. /v1/messages clients get Anthropic Messages SSE and
// /v1/responses clients get OpenAI Responses SSE: typed events, no `choices`.
const ev = (o) => `data: ${JSON.stringify(o)}`;

describe("inspectSSELine — Anthropic Messages client format", () => {
  it("text_delta with text IS content; empty text_delta is NOT", () => {
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })).content).toBe(false);
  });
  it("thinking_delta is NOT content (as reasoning_content is not), but marks the stream alive", () => {
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })).content).toBe(false);
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })).alive).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })).alive).toBe(true);
  });
  it("a tool_use block start IS content; input_json_delta with JSON IS content", () => {
    expect(inspectSSELine(ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "f", input: {} } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":" } })).content).toBe(true);
  });
  it("message_start, an empty text block start, ping, message_stop, error are NOT content", () => {
    for (const o of [
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "ping" },
      { type: "message_stop" },
      { type: "error", error: { type: "api_error", message: "x" } },
    ]) expect(inspectSSELine(ev(o)).content).toBe(false);
  });
  it("message_delta stop_reason maps to the hub vocabulary; refusal → content_filter (no-retry)", () => {
    expect(inspectSSELine(ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })).finishReason).toBe("stop");
    const refusal = inspectSSELine(ev({ type: "message_delta", delta: { stop_reason: "refusal" } })).finishReason;
    expect(refusal).toBe("content_filter");
    expect(isNoRetryFinish(refusal)).toBe(true);
  });
});

describe("inspectSSELine — OpenAI Responses client format", () => {
  const fc = { id: "fc_call_1", type: "function_call", arguments: "", call_id: "call_1", name: "f" };
  const ctc = { id: "ctc_call_2", type: "custom_tool_call", input: "", call_id: "call_2", name: "apply_patch" };
  it("response.output_text.delta with text IS content; empty delta is NOT", () => {
    expect(inspectSSELine(ev({ type: "response.output_text.delta", item_id: "msg_1", delta: "hi" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_text.delta", item_id: "msg_1", delta: "" })).content).toBe(false);
  });
  it("response.output_text.done with text IS content; empty text is NOT", () => {
    expect(inspectSSELine(ev({ type: "response.output_text.done", item_id: "msg_1", text: "hi" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_text.done", item_id: "msg_1", text: "" })).content).toBe(false);
  });
  it("a function_call or custom_tool_call output item (added or done) IS content", () => {
    expect(inspectSSELine(ev({ type: "response.output_item.added", output_index: 0, item: fc })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_item.done", output_index: 0, item: { ...fc, arguments: "{}" } })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.output_item.added", output_index: 0, item: ctc })).content).toBe(true);
  });
  it("function-call argument / custom-tool input deltas with text ARE content; empty ones are NOT", () => {
    expect(inspectSSELine(ev({ type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: "{\"a\":" })).content).toBe(true);
    expect(inspectSSELine(ev({ type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: "" })).content).toBe(false);
    expect(inspectSSELine(ev({ type: "response.custom_tool_call_input.delta", item_id: "ctc_call_2", delta: "*** Begin Patch" })).content).toBe(true);
  });
  it("reasoning text deltas mark the stream alive", () => {
    expect(inspectSSELine(ev({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "t" })).alive).toBe(true);
    expect(inspectSSELine(ev({ type: "response.reasoning_text.delta", item_id: "rs_1", delta: "t" })).alive).toBe(true);
    expect(inspectSSELine(ev({ type: "response.reasoning_text.delta", item_id: "rs_1", delta: "" })).alive).toBe(false);
  });
  it("reasoning items and reasoning / reasoning-summary deltas are NOT content", () => {
    for (const o of [
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking" },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "thinking" },
      { type: "response.reasoning_text.delta", item_id: "rs_1", delta: "thinking" },
      { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] } },
    ]) expect(inspectSSELine(ev(o)).content).toBe(false);
  });
  it("response.created, response.in_progress, a message item / empty content part are NOT content", () => {
    for (const o of [
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } },
      { type: "response.content_part.added", item_id: "msg_1", part: { type: "output_text", text: "" } },
    ]) expect(inspectSSELine(ev(o)).content).toBe(false);
  });
  it("response.completed → stop (retryable when empty)", () => {
    const r = inspectSSELine(ev({ type: "response.completed", response: { id: "resp_1", status: "completed" } }));
    expect(r).toMatchObject({ content: false, finishReason: "stop" });
    expect(isNoRetryFinish(r.finishReason)).toBe(false);
  });
  it("response.incomplete: content_filter → content_filter (no-retry); max_output_tokens → length", () => {
    const filtered = inspectSSELine(ev({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }));
    expect(filtered).toMatchObject({ content: false, finishReason: "content_filter" });
    expect(isNoRetryFinish(filtered.finishReason)).toBe(true);
    const truncated = inspectSSELine(ev({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }));
    expect(truncated.finishReason).toBe("length");
  });
  it("response.failed → a finish that falls through (not no-retry)", () => {
    const r = inspectSSELine(ev({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "x" } } }));
    expect(r).toMatchObject({ content: false, finishReason: "failed" });
    expect(isNoRetryFinish(r.finishReason)).toBe(false);
  });
});

// Combos through the real combo.js, each member's Response built by the real streaming
// pipeline (upstream bytes → client-format transform), per client format.
describe("combo fall-through per client format (real combo.js + streaming pipeline)", async () => {
  const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
  const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
  const { handleComboChat } = await import("../../open-sse/services/combo.js");
  const { initTranslators } = await import("../../open-sse/translator/index.js");
  const { FORMATS } = await import("../../open-sse/translator/formats.js");
  await initTranslators();

  const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const memberResponse = async (frames, sourceFormat, targetFormat, model) => {
    const body = { model, stream: true, messages: [{ role: "user", content: "hi" }] };
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
      provider: "openai", model, connectionId: "conn", apiKey: "sk-x", requestStartTime: Date.now(), body, stream: true,
      clientRawRequest: { endpoint: "/v1/chat/completions" }, reqTag: "t", log: LOG,
    });
    const res = await handleStreamingResponse({
      providerResponse: new Response(sseStream(frames), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      provider: "openai", model, sourceFormat, targetFormat, body, stream: true, requestStartTime: Date.now(),
      connectionId: "conn", apiKey: "sk-x", streamController: createStreamController({ log: LOG, provider: "openai", model }),
      onStreamComplete, streamDetailId, reqTag: "t", log: LOG,
    });
    return res.response;
  };
  async function combo(memberFrames, { sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI } = {}) {
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: memberFrames.map((_, i) => `openai/m${i}`),
      handleSingleModel: async (_b, m) => { tried.push(m); return memberResponse(memberFrames[Number(m.slice(-1))], sourceFormat, targetFormat, m); },
      log: LOG, comboName: `c-${Math.random()}`, comboStrategy: "fallback",
    });
    return { out: await res.text(), tried };
  }
  const C = (t) => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${t}"},"finish_reason":null}]}\n\n`;
  const TOOL = `data: {"id":"xxxxxxxxxx","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":null}]}\n\n`;
  const STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
  // chat-format provider frames, translated per client format
  const clients = {
    "OpenAI chat": { sourceFormat: FORMATS.OPENAI },
    "Anthropic Messages": { sourceFormat: FORMATS.CLAUDE },
    "OpenAI Responses": { sourceFormat: FORMATS.OPENAI_RESPONSES },
  };
  for (const [name, fmt] of Object.entries(clients)) {
    describe(`${name} client`, () => {
      it("a good first member is committed — the next member is NOT called", async () => {
        const { out, tried } = await combo([[ROLE, C("from-m0"), STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
        expect(out).toContain("from-m0");
      });
      it("empty-content first member (role + stop), good second → falls through", async () => {
        const { out, tried } = await combo([[ROLE, STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).toContain("from-m1");
      });
      it("zero-byte first member, good second → falls through", async () => {
        const { out, tried } = await combo([[], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).toContain("from-m1");
      });
      it("all members empty → every member is tried, the last one is returned as-is", async () => {
        const { out, tried } = await combo([[ROLE, STOP, DONE], [ROLE, STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0", "openai/m1"]);
        expect(out).not.toContain("from-m");
      });
      it("a tool call counts as content", async () => {
        const { tried } = await combo([[ROLE, TOOL, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
      });
      // Trade-off: a thinking frame commits the member so reasoning models stream at once;
      // a think-then-abort member is therefore delivered rather than failed over.
      it("a member that starts reasoning is committed (streams immediately)", async () => {
        const { tried } = await combo([[ROLE, REASONING, STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], fmt);
        expect(tried).toEqual(["openai/m0"]);
      });
    });
  }
  it("OpenAI chat / Anthropic clients: a content_filter finish is NOT retried", async () => {
    for (const sourceFormat of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      const { tried } = await combo([[ROLE, FILTER_STOP, DONE], [ROLE, C("from-m1"), STOP, DONE]], { sourceFormat });
      expect(tried).toEqual(["openai/m0"]);
    }
  });

  // Responses provider + Responses client: same-format passthrough of Responses events.
  describe("OpenAI Responses client, Responses provider (passthrough)", () => {
    const RESP = { sourceFormat: FORMATS.OPENAI_RESPONSES, targetFormat: FORMATS.OPENAI_RESPONSES };
    const rev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const CREATED = rev({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } });
    const COMPLETED = rev({ type: "response.completed", response: { id: "resp_1", status: "completed" } });
    const TEXT = (t) => rev({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: t });
    const FC = rev({ type: "response.output_item.added", output_index: 0, item: { id: "fc_call_1", type: "function_call", arguments: "", call_id: "call_1", name: "f" } });
    const REASON = rev({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "hmm" });
    const FILTERED = rev({ type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" } } });
    it("good first → only the first member is called", async () => {
      const { out, tried } = await combo([[CREATED, TEXT("from-m0"), COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0"]);
      expect(out).toContain("from-m0");
    });
    it("empty first (created → completed), good second → falls through", async () => {
      const { out, tried } = await combo([[CREATED, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0", "openai/m1"]);
      expect(out).toContain("from-m1");
    });
    it("zero-byte first (response.failed terminal) → falls through, the failure is not forwarded", async () => {
      const { out, tried } = await combo([[], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0", "openai/m1"]);
      expect(out).toContain("from-m1");
      expect(out).not.toContain("response.failed");
    });
    it("a function_call item counts as content; reasoning text commits the member too", async () => {
      expect((await combo([[CREATED, FC, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP)).tried).toEqual(["openai/m0"]);
      expect((await combo([[CREATED, REASON, COMPLETED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP)).tried).toEqual(["openai/m0"]);
    });
    it("response.incomplete (content_filter) is NOT retried", async () => {
      const { out, tried } = await combo([[CREATED, FILTERED], [CREATED, TEXT("from-m1"), COMPLETED]], RESP);
      expect(tried).toEqual(["openai/m0"]);
      expect(out).toContain('"reason":"content_filter"');
    });
  });
});

describe("combo stops when the client disconnects", async () => {
  const { handleComboChat } = await import("../../open-sse/services/combo.js");
  const LOG = { info: vi.fn(), warn: vi.fn() };
  const SSE = { "Content-Type": "text/event-stream" };

  it("aborting during the peek does not call the next member and cancels the held stream", async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    const tried = [];
    const hanging = () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(ROLE)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: SSE });
    setTimeout(() => ctrl.abort(), 20);
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/m0", "openai/m1"],
      handleSingleModel: async (_b, m) => { tried.push(m); return hanging(); },
      log: LOG, comboName: `abort-${Math.random()}`, comboStrategy: "fallback",
      signal: ctrl.signal,
    });
    expect(tried).toEqual(["openai/m0"]);
    expect(res.status).toBe(499);
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  it("does not advance to the next member once the client is gone", async () => {
    const ctrl = new AbortController();
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/m0", "openai/m1"],
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        ctrl.abort(); // client leaves while m0 is failing
        return Response.json({ error: { message: "upstream down" } }, { status: 503 });
      },
      log: LOG, comboName: `abort2-${Math.random()}`, comboStrategy: "fallback",
      signal: ctrl.signal,
    });
    expect(tried).toEqual(["openai/m0"]);
    expect(res.status).toBe(499);
  });

  it("a reasoning model in a combo is committed on its first thinking frame", async () => {
    const tried = [];
    const t0 = Date.now();
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["openai/m0", "openai/m1"],
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return new Response(sseStream([ROLE, REASONING, CONTENT, DONE], [0, 0, 2000]), { status: 200, headers: SSE });
      },
      log: LOG, comboName: `think-${Math.random()}`, comboStrategy: "fallback",
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(tried).toEqual(["openai/m0"]);
    res.body.cancel().catch(() => {});
  });
});
