// reasoning_tokens is part of completion_tokens in stored usage; cost must not
// charge it twice. Gemini reports thoughts outside candidatesTokenCount, so its
// extractors fold them into completion first.
import { describe, expect, it } from "vite-plus/test";
import { calculateCostFromTokens } from "../../open-sse/providers/pricing.js";
import { extractUsage, canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { extractUsageFromResponse } from "../../open-sse/handlers/chatCore/requestDetail.js";

const pricing = { input: 1, output: 10 }; // $ per 1M tokens
const usd = (inTok, outTok) => (inTok * 1 + outTok * 10) / 1e6;

describe("calculateCostFromTokens reasoning", () => {
  it("does not double-charge OpenAI reasoning already inside completion_tokens", () => {
    const tokens = canonicalizeUsage(extractUsage({
      usage: { prompt_tokens: 100, completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 400 } },
    }));
    expect(tokens.reasoning_tokens).toBe(400);
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(usd(100, 500), 12);
  });

  it("does not double-charge Responses API reasoning inside output_tokens", () => {
    const tokens = canonicalizeUsage(extractUsage({
      type: "response.completed",
      response: { usage: { input_tokens: 100, output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 } } },
    }));
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(usd(100, 500), 12);
  });

  it("charges the reasoning share at a dedicated reasoning rate when one is set", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 0, completion_tokens: 500, reasoning_tokens: 400 }, { input: 1, output: 10, reasoning: 20 });
    expect(cost).toBeCloseTo((100 * 10 + 400 * 20) / 1e6, 12);
  });

  it("Claude usage (thinking inside output_tokens, no reasoning field) is charged once", () => {
    const tokens = canonicalizeUsage(extractUsage({ type: "message_delta", usage: { input_tokens: 100, output_tokens: 500 } }));
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(usd(100, 500), 12);
  });

  it("Gemini streaming usage: thoughts are folded into completion and charged once", () => {
    const tokens = canonicalizeUsage(extractUsage({
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 400, totalTokenCount: 600 },
    }));
    expect(tokens.completion_tokens).toBe(500);
    expect(tokens.reasoning_tokens).toBe(400);
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(usd(100, 500), 12);
  });

  it("Gemini non-streaming usage: thoughts are folded into completion and charged once", () => {
    const tokens = canonicalizeUsage(extractUsageFromResponse({
      response: { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 400 } },
    }));
    expect(tokens.completion_tokens).toBe(500);
    expect(calculateCostFromTokens(tokens, pricing)).toBeCloseTo(usd(100, 500), 12);
  });

  it("an unfolded record (reasoning > completion) still charges the reasoning", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 0, completion_tokens: 100, reasoning_tokens: 400 }, pricing);
    expect(cost).toBeCloseTo(usd(0, 500), 12);
  });
});
