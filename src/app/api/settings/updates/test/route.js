import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { currentVersion } from "@/lib/updates/releases.js";
import { sendWebhook } from "@/lib/updates/webhook.js";

export const dynamic = "force-dynamic";

/** Calls the saved hook once with event "regent.test". Takes no URL from the browser. */
export async function POST() {
  const settings = await getSettings();
  if (!settings.updateWebhookUrl)
    return NextResponse.json({ error: "No deploy hook saved" }, { status: 400 });
  const current = currentVersion();
  const result = await sendWebhook(
    settings.updateWebhookUrl,
    {
      version: current,
      current,
      test: true,
    },
    { token: settings.updateWebhookToken || "" },
  );
  await updateSettings({ updateWebhookLastResult: result });
  return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
}
