import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { setPricePlan } from "@/lib/db/repos/pricePlansRepo.js";
import { invalidateBillingCache, listPlans, validatePlan } from "@/lib/billing/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Price plans and which keys use them: { plans: {id: plan}, keyPlans: {keyId: planId} }.
 * "default" is always present. Keys are referenced by id only; key strings are never returned.
 */
export async function GET() {
  try {
    return NextResponse.json(await listPlans(), { headers: NO_STORE });
  } catch (error) {
    console.warn("[billing] list failed:", error?.message || error);
    return NextResponse.json({ error: "Couldn't load price plans" }, { status: 500 });
  }
}

/** Creates a named plan. */
export async function POST(request) {
  const body = await request.json().catch(() => null);
  const { value, error } = validatePlan(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const id = `plan_${randomBytes(6).toString("hex")}`;
  await setPricePlan(id, value);
  invalidateBillingCache();
  return NextResponse.json({ id, plan: value }, { status: 201, headers: NO_STORE });
}
