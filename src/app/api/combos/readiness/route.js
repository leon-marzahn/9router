import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { getStepReadiness } from "@/sse/services/stepReadiness.js";

export const dynamic = "force-dynamic";

// GET /api/combos/readiness -> { steps: { [step]: { state, provider, accounts, ready, until } } }
// Cheap: reads connection rows only, no upstream calls.
export async function GET() {
  try {
    const combos = await getCombos();
    const steps = [...new Set(combos.flatMap((c) => c.models || []))];
    const entries = await Promise.all(steps.map(async (s) => [s, await getStepReadiness(s)]));
    return NextResponse.json({ steps: Object.fromEntries(entries) });
  } catch (error) {
    console.log("Error reading combo readiness:", error);
    return NextResponse.json({ error: "Failed to read readiness" }, { status: 500 });
  }
}
