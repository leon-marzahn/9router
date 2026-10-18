import { describe, expect, it } from "vite-plus/test";
import { feedItemOf, isFailed, fmtCost } from "@/app/(dashboard)/dashboard/usage/live/useUsage";

describe("usage live feed mapping", () => {
  it("maps a logged request summary, including cached tokens and credits", () => {
    const item = feedItemOf({
      id: "r1",
      timestamp: "2026-10-18T10:00:00Z",
      model: "claude-sonnet-5-5",
      provider: "kiro",
      status: "success",
      tokens: { prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 800, credits: 1.25 },
      cost: 0.05,
      latency: { ttft: 420, total: 5100 },
      pxpipe: { applied: true, savedPct: 18 },
    });
    expect(item).toMatchObject({
      id: "r1",
      inTokens: 1200,
      outTokens: 300,
      cachedTokens: 800,
      credits: 1.25,
      cost: 0.05,
      ttft: 420,
      total: 5100,
      pxpipeSavedPct: 18,
      logged: true,
    });
  });

  it("reads Anthropic-style token names and never reports input below the cache", () => {
    const item = feedItemOf({
      id: "r2",
      tokens: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
    });
    expect(item).toMatchObject({ inTokens: 900, outTokens: 20, cachedTokens: 900, credits: 0, cost: 0 });
  });

  it("treats only non-success statuses as failed", () => {
    expect(["success", "ok", "200", "", "completed"].map(isFailed)).toEqual([false, false, false, false, false]);
    expect(["error", "429", "timeout"].map(isFailed)).toEqual([true, true, true]);
  });

  it("formats tiny costs without rounding them to zero", () => {
    expect(fmtCost(0.004)).toBe("<$0.01");
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(12.345)).toBe("$12.35");
  });
});
