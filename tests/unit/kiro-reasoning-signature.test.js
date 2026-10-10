// Kiro reasoning signatures: response -> signature_delta, request history -> reasoningContent.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

describe("Kiro reasoning signature round trip", () => {
  it("emits signature_delta and keeps it past the empty-delta filter", () => {
    const state = initState(FORMATS.CLAUDE);
    const chunk = (delta) => ({ id: "chatcmpl-x1234567", model: "kiro", choices: [{ index: 0, delta, finish_reason: null }] });
    const out = [chunk({ role: "assistant", reasoning_signature: "SIG" }), chunk({ content: "hi" })]
      .flatMap((c) => translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, c, state) || []);
    const sig = out.find((e) => e.delta?.type === "signature_delta");
    expect(sig.delta.signature).toBe("SIG");
    expect(hasValuableContent(sig, FORMATS.CLAUDE)).toBe(true);
  });

  it("replays signed thinking blocks as reasoningContent in history", () => {
    const body = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "SIG" }, { type: "text", text: "a" }] },
        { role: "user", content: "next" },
      ],
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-4.5", body, true, null, "kiro");
    const asst = out.conversationState.history.find((h) => h.assistantResponseMessage).assistantResponseMessage;
    expect(asst.reasoningContent).toEqual({ reasoningText: { text: "t", signature: "SIG" } });
  });

  it("does not replay placeholder signatures injected by other providers", () => {
    const body = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "...", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE }, { type: "text", text: "a" }] },
        { role: "user", content: "next" },
      ],
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-4.5", body, true, null, "kiro");
    const asst = out.conversationState.history.find((h) => h.assistantResponseMessage).assistantResponseMessage;
    expect(asst.reasoningContent).toBeUndefined();
  });

  it("maps redacted_thinking to redactedContent", () => {
    const body = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "BLOB" }, { type: "text", text: "a" }] },
        { role: "user", content: "next" },
      ],
    };
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-4.5", body, true, null, "kiro");
    const asst = out.conversationState.history.find((h) => h.assistantResponseMessage).assistantResponseMessage;
    expect(asst.reasoningContent).toEqual({ redactedContent: "BLOB" });
  });
});
