import { NextResponse } from "next/server";
import { enableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { tunnelExposureProblem } from "@/lib/tunnel/exposureGuard";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  try {
    const problem = await tunnelExposureProblem();
    if (problem) return NextResponse.json({ error: problem, code: "unsafe" }, { status: 403 });
    const result = await enableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale enable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
