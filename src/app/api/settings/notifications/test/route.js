import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { isEmail } from "@/lib/notify/config.js";
import { safeError, sendEmail } from "@/lib/notify/index.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const COOLDOWN_MS = 5000;

/** Sends one test email with the saved settings to `to` (default: the admin email). */
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const settings = await getSettings();
  const to = String(body?.to || settings.notifyAdminEmail || "").trim();
  if (!isEmail(to)) {
    return NextResponse.json({ error: "Enter a valid recipient address" }, { status: 400 });
  }
  const last = settings.notifyLastTest?.at ? Date.parse(settings.notifyLastTest.at) : 0;
  if (Date.now() - last < COOLDOWN_MS) {
    return NextResponse.json(
      { error: "Wait a few seconds before sending another test" },
      { status: 429 },
    );
  }

  const at = new Date().toISOString();
  let result;
  try {
    await sendEmail(settings, {
      to,
      subject: "Elizabeth's Proxy test email",
      text: "This is a test email from Elizabeth's Proxy. Budget alerts will be delivered the same way.",
    });
    result = { ok: true, at, to };
  } catch (e) {
    result = { ok: false, at, to, error: safeError(e, settings) };
  }
  await updateSettings({ notifyLastTest: result });
  return NextResponse.json({ result }, { headers: NO_STORE });
}
