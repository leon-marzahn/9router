import { NextResponse } from "next/server";
import { deletePricePlan, getPricePlan, setPricePlan } from "@/lib/db/repos/pricePlansRepo.js";
import {
  DEFAULT_PLAN_ID,
  PLAN_ID_RE,
  invalidateBillingCache,
  validatePlan,
} from "@/lib/billing/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** "default" or an existing plan id; null otherwise. */
async function resolveId(params) {
  const { id } = await params;
  if (typeof id !== "string" || !PLAN_ID_RE.test(id)) return null;
  if (id === DEFAULT_PLAN_ID) return id;
  return (await getPricePlan(id)) ? id : null;
}

/** Saves a plan. Only future requests are charged at the new prices. */
export async function PUT(request, { params }) {
  const id = await resolveId(params);
  if (!id) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const { value, error } = validatePlan(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  await setPricePlan(id, value);
  invalidateBillingCache();
  return NextResponse.json({ id, plan: value }, { headers: NO_STORE });
}

/** Deletes a plan; its keys move to the default plan. Deleting "default" resets it to cost. */
export async function DELETE(_request, { params }) {
  const id = await resolveId(params);
  if (!id) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  await deletePricePlan(id);
  invalidateBillingCache();
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
