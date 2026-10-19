// RTK must fail open: errors -> null with the body untouched; error tool results never compressed.
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { compressMessages, formatRtkLog } from "../../open-sse/rtk/index.js";
import { ROLE, CLAUDE_BLOCK, OPENAI_BLOCK, RESPONSES_ITEM } from "../../open-sse/translator/schema/index.js";

// Repetitive log output that the dedup/log filters can shrink.
const NOISY = Array.from({ length: 400 }, () => "INFO same line repeated over and over again").join("\n");

afterEach(() => vi.restoreAllMocks());

describe("compressMessages fail-open", () => {
  it("returns null when disabled, body missing, or no messages/input", () => {
    expect(compressMessages({ messages: [] }, false)).toBeNull();
    expect(compressMessages(null, true)).toBeNull();
    expect(compressMessages({ foo: 1 }, true)).toBeNull();
  });

  it("returns null and leaves earlier content untouched when a message throws mid-walk", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const evil = {};
    Object.defineProperty(evil, "type", { get() { throw new Error("boom"); } });
    const body = { messages: [{ role: ROLE.USER, content: "hi" }, evil] };
    expect(compressMessages(body, true)).toBeNull();
    expect(body.messages[0].content).toBe("hi");
  });

  it("returns null for a Kiro body whose history throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = {};
    Object.defineProperty(state, "history", { get() { throw new Error("boom"); } });
    expect(compressMessages({ conversationState: state }, true)).toBeNull();
  });

  it("skips is_error tool_result blocks (string and array forms)", () => {
    const body = { messages: [{ role: ROLE.USER, content: [
      { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: "t", is_error: true, content: NOISY },
      { type: CLAUDE_BLOCK.TOOL_RESULT, tool_use_id: "u", is_error: true, content: [{ type: CLAUDE_BLOCK.TEXT, text: NOISY }] },
    ] }] };
    const stats = compressMessages(body, true);
    expect(body.messages[0].content[0].content).toBe(NOISY);
    expect(body.messages[0].content[1].content[0].text).toBe(NOISY);
    expect(stats.hits).toEqual([]);
    expect(stats.bytesBefore).toBe(0);
  });

  it("skips Kiro toolResults with status error but walks the others", () => {
    const err = { status: "error", content: [{ text: NOISY }] };
    const ok = { status: "success", content: [{ text: "short" }] };
    const body = { conversationState: {
      history: [{ userInputMessage: { userInputMessageContext: { toolResults: [err, { content: "not-array" }] } } }, {}],
      currentMessage: { userInputMessage: { userInputMessageContext: { toolResults: [ok] } } },
    } };
    const stats = compressMessages(body, true);
    expect(err.content[0].text).toBe(NOISY);
    expect(stats.bytesBefore).toBe("short".length);
  });

  it("never grows short tool content and records byte totals across all shapes", () => {
    const body = { input: [
      { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, output: "a" },
      { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, output: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "bb" }, null] },
      null,
      { role: ROLE.TOOL, content: "ccc" },
      { role: ROLE.TOOL, content: [{ type: OPENAI_BLOCK.TEXT, text: "dddd" }] },
      { role: ROLE.USER, content: [null, { type: CLAUDE_BLOCK.TOOL_RESULT, content: "e" }] },
    ] };
    const snapshot = JSON.parse(JSON.stringify(body));
    const stats = compressMessages(body, true);
    expect(body).toEqual(snapshot);
    expect(stats.bytesBefore).toBe(1 + 2 + 3 + 4 + 1);
    expect(stats.bytesAfter).toBe(stats.bytesBefore);
  });

  it("compresses a non-error noisy tool_result without growing it", () => {
    const body = { messages: [{ role: ROLE.USER, content: [{ type: CLAUDE_BLOCK.TOOL_RESULT, content: NOISY }] }] };
    const stats = compressMessages(body, true);
    expect(stats.bytesAfter).toBeLessThanOrEqual(stats.bytesBefore);
    expect(body.messages[0].content[0].content.length).toBeLessThanOrEqual(NOISY.length);
  });

  it("formatRtkLog returns null without hits", () => {
    expect(formatRtkLog(null)).toBeNull();
    expect(formatRtkLog({ hits: [] })).toBeNull();
  });
});
