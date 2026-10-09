import { beforeEach, describe, expect, it } from "vitest";
import {
  buildKiroCacheContext,
  estimateKiroCachedTokens,
  resetKiroCacheEstimator,
} from "../../open-sse/utils/kiroCacheEstimate.js";

const TIME = "[Context: Current time is 2026-10-08T22:00:00.000Z]";

const body = (conversationId, content, toolResults, history = [{ assistantResponseMessage: { content: "earlier" } }]) => ({
  conversationState: {
    conversationId,
    history,
    currentMessage: {
      userInputMessage: {
        content,
        ...(toolResults && { userInputMessageContext: { toolResults } }),
      },
    },
  },
});

describe("buildKiroCacheContext", () => {
  it("returns null without a conversation id or current message", () => {
    expect(buildKiroCacheContext({})).toBeNull();
    expect(buildKiroCacheContext(body("", "hi"))).toBeNull();
    expect(buildKiroCacheContext(null)).toBeNull();
  });

  it("detects the injected time context and sizes the last user message", () => {
    const withTime = buildKiroCacheContext(body("c1", `${TIME}\n\n${"x".repeat(400)}`));
    expect(withTime.timeAdded).toBe(true);
    expect(withTime.lastUserTokens).toBeGreaterThan(100);

    const withoutTime = buildKiroCacheContext(body("c1", "x".repeat(400)));
    expect(withoutTime.timeAdded).toBe(false);
  });

  it("counts tool results as part of the last user message", () => {
    const ctx = buildKiroCacheContext(body("c1", "ok", [{ toolUseId: "t1", content: [{ text: "y".repeat(4000) }] }]));
    expect(ctx.lastUserTokens).toBeGreaterThan(900);
  });
});

describe("estimateKiroCachedTokens", () => {
  beforeEach(() => resetKiroCacheEstimator());

  const ctx = (id, { time = false, size = 400 } = {}) =>
    buildKiroCacheContext(body(id, `${time ? `${TIME}\n\n` : ""}${"x".repeat(size)}`));

  it("reports nothing for the first request of a conversation", () => {
    expect(estimateKiroCachedTokens(ctx("c1"), 20000)).toBe(0);
  });

  it("caches the whole previous prompt when no time context was added", () => {
    estimateKiroCachedTokens(ctx("c1"), 20000);
    expect(estimateKiroCachedTokens(ctx("c1"), 20600)).toBe(20000);
  });

  it("excludes the previous last user message when it carried a timestamp", () => {
    estimateKiroCachedTokens(ctx("c1", { time: true, size: 4000 }), 20000);
    const lastUser = buildKiroCacheContext(body("c1", `${TIME}\n\n${"x".repeat(4000)}`)).lastUserTokens;
    expect(estimateKiroCachedTokens(ctx("c1", { time: true }), 21500)).toBe(20000 - lastUser);
  });

  it("keeps the first message cached even with a timestamp (replay freezes it)", () => {
    const first = buildKiroCacheContext(body("c1", `${TIME}\n\n${"x".repeat(4000)}`, undefined, []));
    expect(first.isFirstTurn).toBe(true);
    estimateKiroCachedTokens(first, 7353);
    expect(estimateKiroCachedTokens(ctx("c1", { time: true }), 7500)).toBe(7353);
  });

  it("never reports a full hit: the newest user message is always uncached", () => {
    estimateKiroCachedTokens(ctx("c1"), 20000);
    // 400 chars of new user message = 100 tokens
    expect(estimateKiroCachedTokens(ctx("c1"), 15000)).toBe(14900);
  });

  it("caps a prompt that shrank below the previous one", () => {
    estimateKiroCachedTokens(ctx("c1"), 144619);
    expect(estimateKiroCachedTokens(ctx("c1"), 144108)).toBe(144008);
  });

  it("keeps conversations separate", () => {
    estimateKiroCachedTokens(ctx("a"), 20000);
    expect(estimateKiroCachedTokens(ctx("b"), 20500)).toBe(0);
  });

  it("returns 0 without context or prompt tokens", () => {
    expect(estimateKiroCachedTokens(null, 20000)).toBe(0);
    expect(estimateKiroCachedTokens(ctx("c1"), 0)).toBe(0);
    expect(estimateKiroCachedTokens(ctx("c1"), undefined)).toBe(0);
  });
});
