import { describe, it, expect } from "vite-plus/test";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { toWindow, pctText } from "../../src/app/(dashboard)/dashboard/quota/workbench/useQuota.ts";

// Shape returned by getDeepseekUsage for GET /user/balance with
// balance_infos: [{ currency: "USD", total_balance: "12.50", ... }].
const DEEPSEEK_USAGE = {
  plan: "DeepSeek",
  quotas: {
    "Balance (USD)": {
      used: 0,
      total: 12.5,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
      isCreditBalance: true,
      currency: "USD",
    },
  },
};

describe("Quota page credit balance (DeepSeek)", () => {
  it("shows the remaining balance amount, not $0.00", () => {
    const [row] = parseQuotaData("deepseek", DEEPSEEK_USAGE);
    const w = toWindow(row);
    expect(w.credit).toEqual({ amount: 12.5, currency: "USD" });
    expect(w.remaining).toBeNull();
    expect(pctText(w)).toBe("$12.50");
  });

  it("prefers an explicit absolute remaining amount when present", () => {
    const w = toWindow({ name: "Credit", isCreditBalance: true, remaining: 3, total: 10 });
    expect(w.credit?.amount).toBe(3);
  });
});
