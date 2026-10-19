import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { publicNotifyState, validateNotifyPatch } from "@/lib/notify/config.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Email delivery settings. The SMTP password and Resend key are never returned. */
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ notifications: publicNotifyState(settings) }, { headers: NO_STORE });
}

/**
 * { provider?, from?, adminEmail?, smtpHost?, smtpPort?, smtpTls?, smtpUser?,
 *   smtpPassword?, resendKey? } — secrets: omit to keep, "" to clear.
 */
export async function PATCH(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { patch, error } = validateNotifyPatch(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  // A new SMTP host never inherits the old password: it could be a different server.
  if (patch.notifySmtpHost !== undefined && body.smtpPassword === undefined) {
    const current = await getSettings();
    if (current.notifySmtpHost && patch.notifySmtpHost !== current.notifySmtpHost) {
      patch.notifySmtpPassword = "";
    }
  }
  const settings = await updateSettings(patch);
  return NextResponse.json({ notifications: publicNotifyState(settings) }, { headers: NO_STORE });
}
