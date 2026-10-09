import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKiroCacheContext,
  estimateKiroCachedTokens,
  resetKiroCacheEstimator,
} from "../../open-sse/utils/kiroCacheEstimate.js";

const TIME = "[Context: Current time is 2026-10-08T22:00:00.000Z]";
const START = `system prompt and first message ${"s".repeat(400)}`;

const user = (content, modelId = "m") => ({ userInputMessage: { content, modelId } });
const assistant = (content) => ({ assistantResponseMessage: { content } });
const current = (content, modelId, toolResults) => ({
  userInputMessage: {
    content,
    modelId,
    ...(toolResults && { userInputMessageContext: { toolResults } }),
  },
});

// Turn 1: the only message is the session start, so there is no history.
const first = (start = START, modelId = "m", scope) =>
  buildKiroCacheContext({ conversationState: { history: [], currentMessage: current(start, modelId) } }, scope);

// Later turn: the frozen session start leads the history, then `pairs` finished exchanges.
const later = (last, { start = START, pairs = 1, modelId = "m", toolResults, scope } = {}) => {
  const history = [user(start, modelId), assistant("a")];
  for (let i = 1; i < pairs; i++) history.push(user(`u${i}`, modelId), assistant("a"));
  return buildKiroCacheContext(
    { conversationState: { history, currentMessage: current(last, modelId, toolResults) } },
    scope
  );
};

describe("buildKiroCacheContext", () => {
  it("returns null without a current message or a first message", () => {
    expect(buildKiroCacheContext({})).toBeNull();
    expect(buildKiroCacheContext(null)).toBeNull();
    expect(first("")).toBeNull();
  });

  it("detects the injected time context and sizes the last user message", () => {
    const withTime = later(`${TIME}\n\n${"x".repeat(400)}`);
    expect(withTime.timeAdded).toBe(true);
    expect(withTime.lastUserTokens).toBeGreaterThan(100);
    expect(later("x".repeat(400)).timeAdded).toBe(false);
  });

  it("counts tool results as part of the last user message", () => {
    const ctx = later("ok", { toolResults: [{ toolUseId: "t1", content: [{ text: "y".repeat(4000) }] }] });
    expect(ctx.lastUserTokens).toBeGreaterThan(900);
  });

  it("keys every turn of a chat on its first message, connection and model", () => {
    const key = first().key;
    expect(later("hi").key).toBe(key);
    expect(later("something else", { pairs: 3 }).key).toBe(key);
    expect(first(`${START} other`).key).not.toBe(key);
    expect(first(START, "m2").key).not.toBe(key);
    expect(first(START, "m", "conn-2").key).not.toBe(key);
  });
});

describe("estimateKiroCachedTokens", () => {
  beforeEach(() => resetKiroCacheEstimator());

  it("reports nothing for the first request of a conversation", () => {
    expect(estimateKiroCachedTokens(first(), 20000)).toBe(0);
  });

  it("caches the whole previous prompt when no time context was added", () => {
    estimateKiroCachedTokens(first(), 20000);
    expect(estimateKiroCachedTokens(later("x".repeat(400)), 20600)).toBe(20000);
  });

  it("excludes the previous last user message when it carried a timestamp", () => {
    const stamped = later(`${TIME}\n\n${"x".repeat(4000)}`);
    estimateKiroCachedTokens(stamped, 20000);
    expect(estimateKiroCachedTokens(later("next", { pairs: 2 }), 21500)).toBe(20000 - stamped.lastUserTokens);
  });

  it("keeps the first message cached even with a timestamp (replay freezes it)", () => {
    const stampedStart = `${TIME}\n\n${"x".repeat(4000)}`;
    const turn1 = first(stampedStart);
    expect(turn1.isFirstTurn).toBe(true);
    estimateKiroCachedTokens(turn1, 7353);
    expect(estimateKiroCachedTokens(later("x".repeat(400), { start: stampedStart }), 7500)).toBe(7353);
  });

  it("never reports a full hit for a changed request: the newest message is uncached", () => {
    estimateKiroCachedTokens(first(), 20000);
    // 400 chars of new user message = 100 tokens
    expect(estimateKiroCachedTokens(later("x".repeat(400)), 15000)).toBe(14900);
  });

  it("caps a prompt that shrank below the previous one", () => {
    estimateKiroCachedTokens(first(), 144619);
    expect(estimateKiroCachedTokens(later("x".repeat(400)), 144108)).toBe(144008);
  });

  it("keeps chats with different first messages separate", () => {
    estimateKiroCachedTokens(first("one"), 20000);
    expect(estimateKiroCachedTokens(first("two"), 20500)).toBe(0);
  });

  it("counts a new chat that opens identically as cached", () => {
    estimateKiroCachedTokens(first(), 87274);
    // exact repeat of the opening request: Kiro serves it whole
    expect(estimateKiroCachedTokens(first(), 87274)).toBe(87274);
  });

  it("treats an exact repeat as a full hit, a changed request as not", () => {
    estimateKiroCachedTokens(later("hello"), 20000);
    expect(estimateKiroCachedTokens(later("hello"), 20000)).toBe(20000);
    expect(estimateKiroCachedTokens(later("hello again"), 20000)).toBeLessThan(20000);
  });

  it("caches only the previous prompt when the request grew", () => {
    estimateKiroCachedTokens(later("hello"), 20000);
    // same last message but a longer history is not a repeat; only the old 20000 are cached
    expect(estimateKiroCachedTokens(later("hello", { pairs: 2 }), 20100)).toBe(20000);
  });

  it("returns 0 without context or prompt tokens", () => {
    expect(estimateKiroCachedTokens(null, 20000)).toBe(0);
    expect(estimateKiroCachedTokens(first(), 0)).toBe(0);
    expect(estimateKiroCachedTokens(first(), undefined)).toBe(0);
  });

  describe("cache lifetime", () => {
    const MIN = 60 * 1000;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it("counts a follow-up inside five minutes", () => {
      estimateKiroCachedTokens(first(), 20000);
      vi.advanceTimersByTime(4 * MIN);
      expect(estimateKiroCachedTokens(later("x".repeat(400)), 20600)).toBe(20000);
    });

    it("reports 0 once the entry is older than five minutes", () => {
      estimateKiroCachedTokens(first(), 20000);
      vi.advanceTimersByTime(6 * MIN);
      expect(estimateKiroCachedTokens(later("x".repeat(400)), 20600)).toBe(0);
    });

    it("lets a hit extend the lifetime", () => {
      estimateKiroCachedTokens(first(), 20000);
      vi.advanceTimersByTime(4 * MIN);
      estimateKiroCachedTokens(later("x".repeat(400)), 20600);
      vi.advanceTimersByTime(4 * MIN);
      expect(estimateKiroCachedTokens(later("x".repeat(400), { pairs: 2 }), 21200)).toBe(20600);
    });

    it("starts over after an expired entry, so the next turn counts again", () => {
      estimateKiroCachedTokens(first(), 20000);
      vi.advanceTimersByTime(10 * MIN);
      estimateKiroCachedTokens(later("x".repeat(400)), 20600);
      expect(estimateKiroCachedTokens(later("x".repeat(400), { pairs: 2 }), 21200)).toBe(20600);
    });
  });
});
