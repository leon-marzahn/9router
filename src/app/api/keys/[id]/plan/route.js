import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/db/repos/apiKeysRepo.js";
import { getPricePlan, setKeyPlanId } from "@/lib/db/repos/pricePlansRepo.js";
import { DEFAULT_PLAN_ID, PLAN_ID_RE, invalidateBillingCache } from "@/lib/billing/index.js";

export const dynamic = "force-dynamic";

/** Puts a key on a price plan. Body: { planId } ("default" or null = the default plan). */
export async function PUT(request, { params }) {
  const { id } = await params;
  const key = await getApiKeyById(String(id));
  if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const planId = body?.planId ?? DEFAULT_PLAN_ID;
  if (typeof planId !== "string" || !PLAN_ID_RE.test(planId))
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  if (planId !== DEFAULT_PLAN_ID && !(await getPricePlan(planId)))
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  await setKeyPlanId(key.id, planId);
  invalidateBillingCache();
  return NextResponse.json(
    { keyId: key.id, planId },
    { headers: { "Cache-Control": "no-store" } },
  );
}
