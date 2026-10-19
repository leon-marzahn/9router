import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getBudgets } from "@/lib/db/repos/budgetsRepo.js";
import { GLOBAL_SCOPE, budgetStatus, keyScope } from "@/lib/budgets/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Every budget with its current-period status:
 * { global: {budget, status} | null, keys: { [keyId]: {budget, status} } }.
 * Keys are referenced by id only; key strings are never returned.
 */
export async function GET() {
  try {
    const [budgets, keys] = await Promise.all([getBudgets(), getApiKeys()]);
    const out = { global: null, keys: {} };
    if (budgets[GLOBAL_SCOPE]) {
      const budget = budgets[GLOBAL_SCOPE];
      out.global = { budget, status: await budgetStatus(GLOBAL_SCOPE, budget, null) };
    }
    for (const k of keys) {
      const budget = budgets[keyScope(k.id)];
      if (!budget) continue;
      out.keys[k.id] = { budget, status: await budgetStatus(keyScope(k.id), budget, k.key) };
    }
    return NextResponse.json(out, { headers: NO_STORE });
  } catch (error) {
    console.warn("[budget] list failed:", error?.message || error);
    return NextResponse.json({ error: "Couldn't load budgets" }, { status: 500 });
  }
}
