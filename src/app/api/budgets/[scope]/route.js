import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";
import { deleteBudget, setBudget } from "@/lib/db/repos/budgetsRepo.js";
import {
  GLOBAL_SCOPE,
  budgetStatus,
  invalidateBudgetCache,
  keyScope,
  validateBudget,
} from "@/lib/budgets/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** "global" or an existing API key id → { scope }. */
async function resolveScope(params) {
  const { scope } = await params;
  if (scope === GLOBAL_SCOPE) return { scope: GLOBAL_SCOPE };
  const key = await getApiKeyById(String(scope));
  return key ? { scope: keyScope(key.id) } : null;
}

/** Saves the budget for "global" or one API key id. */
export async function PUT(request, { params }) {
  const target = await resolveScope(params);
  if (!target) return NextResponse.json({ error: "Key not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const { value, error } = validateBudget(body, { isKey: target.scope !== GLOBAL_SCOPE });
  if (error) return NextResponse.json({ error }, { status: 400 });
  await setBudget(target.scope, value);
  invalidateBudgetCache();
  const status = await budgetStatus(target.scope, value);
  return NextResponse.json({ budget: value, status }, { headers: NO_STORE });
}

export async function DELETE(_request, { params }) {
  const target = await resolveScope(params);
  if (!target) return NextResponse.json({ error: "Key not found" }, { status: 404 });
  await deleteBudget(target.scope);
  invalidateBudgetCache();
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
