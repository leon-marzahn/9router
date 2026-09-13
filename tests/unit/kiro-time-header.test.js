import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";

const firstTurn = { role: "user", content: "The castle clock strikes midnight." };
const messages = [
  firstTurn,
  { role: "assistant", content: "The gates open." },
  { role: "user", content: "I step inside." },
];
const currentContent = (payload) => payload.conversationState.currentMessage.userInputMessage.content;

describe.each([
  ["OpenAI", openaiToKiroRequest, (turns) => ({ messages: [{ role: "system", content: "Stay in character." }, ...turns] })],
  ["Claude", claudeToKiroRequest, (turns) => ({ system: "Stay in character.", messages: turns })],
])("%s → Kiro time header", (_format, translate, makeBody) => {
  beforeEach(() => {
    clearKiroSessionReplayStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  });

  afterEach(() => {
    clearKiroSessionReplayStore();
    vi.useRealTimers();
  });

  function request(turns, headers = {}, model = "claude-sonnet-4.6") {
    return translate(model, makeBody(turns), true, {
      connectionId: "kiro-time-test",
      rawHeaders: headers,
    });
  }

  it("keeps timestamps enabled by default and fresh on subsequent turns", () => {
    const headers = { "x-session-id": "time-default" };
    const first = request([firstTurn], headers);
    expect(currentContent(first)).toContain("[Context: Current time is 2026-09-13T12:00:00.000Z]");
    vi.setSystemTime(new Date("2026-09-13T13:00:00.000Z"));
    const second = request(messages, headers);
    expect(second.conversationState.history[0].userInputMessage.content).toBe(currentContent(first));
    expect(currentContent(second)).toContain("[Context: Current time is 2026-09-13T13:00:00.000Z]");
  });

  it.each([
    { "x-9router-kiro-time": "off" },
    { "X-9Router-Kiro-Time": " OFF " },
    new Headers({ "X-9Router-Kiro-Time": "off" }),
  ])("disables time while preserving instructions and model prefixes: %j", (headers) => {
    const body = makeBody(messages);
    const original = structuredClone(body);
    const result = translate("claude-sonnet-4.6-thinking-agentic", body, true, { rawHeaders: headers });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("[Context: Current time is");
    expect(serialized).toContain("Stay in character.");
    expect(serialized).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(serialized).toContain("CHUNKED WRITE PROTOCOL");
    expect(serialized).toContain(firstTurn.content);
    expect(currentContent(result)).toBe("I step inside.");
    expect(body).toEqual(original);
  });

  it("keeps both the cached first turn and later turns free of injected time", () => {
    const headers = { "x-session-id": "time-off", "x-9router-kiro-time": "off" };
    const first = request([firstTurn], headers);
    const second = request(messages, headers);
    expect(JSON.stringify(first)).not.toContain("[Context: Current time is");
    expect(JSON.stringify(second)).not.toContain("[Context: Current time is");
    expect(second.conversationState.history[0].userInputMessage.content).toBe(currentContent(first));
    expect(currentContent(second)).toBe("I step inside.");
  });

  it("rebuilds cached time context when the header changes within a session", () => {
    const headers = { "x-session-id": "time-toggle" };
    const first = request([firstTurn], headers);
    expect(currentContent(first)).toContain("[Context: Current time is");
    const disabled = request(messages, { ...headers, "x-9router-kiro-time": "off" });
    expect(JSON.stringify(disabled)).not.toContain("[Context: Current time is");
    expect(disabled.conversationState.history[0].userInputMessage.content).toContain(firstTurn.content);
    expect(JSON.stringify(disabled)).toContain("Stay in character.");
    const enabled = request(messages, headers);
    expect(enabled.conversationState.history[0].userInputMessage.content).toContain("[Context: Current time is");
    expect(currentContent(enabled)).toContain("[Context: Current time is");
    expect(enabled.conversationState.conversationId).toBe(first.conversationState.conversationId);
  });

  it("preserves client-supplied time context when injection is disabled", () => {
    const content = "[Context: Current time is the third age]";
    const result = request([{ role: "user", content }], { "x-9router-kiro-time": "off" });
    expect(currentContent(result)).toContain(content);
    expect(currentContent(result)).not.toContain("2026-09-13");
  });

  it.each(["on", "", "unknown"])("keeps time enabled for header value %j", (value) => {
    expect(currentContent(request([firstTurn], { "x-9router-kiro-time": value })))
      .toContain("[Context: Current time is");
  });
});
