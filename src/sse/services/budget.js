// /v1 budget gate: refuses a request before any upstream call when the key's (or the
// global) hard-stopped budget is used up. Fail-open: see src/lib/budgets/index.js.
import { checkBudget } from "@/lib/budgets/index.js";
import { extractClientApiKey } from "./keyAccess.js";

export const BUDGET_EXCEEDED_CODE = "budget_exceeded";

export function budgetExceededResponse({ global, resetsAt }) {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000));
  const message = global
    ? "The service's spending limit for this period has been reached. Try again after it resets."
    : "This API key has reached its spending limit for this period. Try again after it resets.";
  return new Response(
    JSON.stringify({ error: { message, type: "insufficient_quota", code: BUDGET_EXCEEDED_CODE } }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": String(retryAfter),
      },
    },
  );
}

/** A 429 Response when over budget, else null. Never throws. */
export async function enforceBudget(request) {
  try {
    const over = await checkBudget(extractClientApiKey(request));
    return over ? budgetExceededResponse(over) : null;
  } catch {
    return null;
  }
}
