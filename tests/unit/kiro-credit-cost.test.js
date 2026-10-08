import { describe, it, expect } from "vitest";
import { USD_PER_CREDIT, creditsToUsd } from "../../open-sse/providers/pricing.js";

describe("creditsToUsd", () => {
  it("prices Kiro at $0.02 per credit (10k credits = $200, 5k = $100)", () => {
    expect(USD_PER_CREDIT.kiro).toBe(0.02);
    expect(creditsToUsd("kiro", 10000)).toBeCloseTo(200, 6);
    expect(creditsToUsd("kiro", 5000)).toBeCloseTo(100, 6);
    expect(creditsToUsd("kiro", 0.15)).toBeCloseTo(0.003, 6);
  });

  it("returns 0 for providers without a credit price", () => {
    expect(creditsToUsd("openai", 100)).toBe(0);
    expect(creditsToUsd(undefined, 100)).toBe(0);
  });

  it("returns 0 for missing or invalid credits", () => {
    expect(creditsToUsd("kiro", undefined)).toBe(0);
    expect(creditsToUsd("kiro", null)).toBe(0);
    expect(creditsToUsd("kiro", -1)).toBe(0);
    expect(creditsToUsd("kiro", "abc")).toBe(0);
  });
});
