import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import {
  currentVersion,
  findUpdate,
  getReleases,
  updateCheckEnabled,
} from "@/lib/updates/releases.js";
import { CHANNELS } from "@/lib/updates/version.js";
import { validateWebhookUrl, webhookHost } from "@/lib/updates/webhook.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function hookState(s) {
  return {
    set: !!s.updateWebhookUrl,
    hasToken: !!s.updateWebhookToken,
    host: s.updateWebhookUrl ? webhookHost(s.updateWebhookUrl) : null,
    channel: s.updateWebhookChannel === "any" ? "any" : "major",
    lastVersion: s.updateWebhookLastVersion || null,
    lastResult: s.updateWebhookLastResult || null,
  };
}

/** Update notice + redeploy-hook state. The hook URL itself is never returned. */
export async function GET() {
  const current = currentVersion();
  const enabled = updateCheckEnabled();
  const releases = enabled ? await getReleases() : null;
  const settings = await getSettings();
  return NextResponse.json(
    {
      current,
      checkEnabled: enabled,
      update: findUpdate(releases, current, "any"),
      webhook: hookState(settings),
    },
    { headers: NO_STORE },
  );
}

/** { url?, token?, channel?: "major" | "any" } — url "" removes the hook and its token. */
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const patch = {};
  if (body.channel !== undefined) {
    if (!CHANNELS.includes(body.channel))
      return NextResponse.json({ error: "Unknown channel" }, { status: 400 });
    patch.updateWebhookChannel = body.channel;
  }
  if (body.token !== undefined) {
    const token = String(body.token ?? "").trim();
    if (/[\r\n]/.test(token) || token.length > 4096)
      return NextResponse.json({ error: "That token isn't valid" }, { status: 400 });
    patch.updateWebhookToken = token;
  }
  if (body.url !== undefined) {
    if (body.url === "" || body.url === null) {
      Object.assign(patch, {
        updateWebhookUrl: "",
        updateWebhookToken: "",
        updateWebhookLastResult: null,
      });
    } else {
      const v = validateWebhookUrl(body.url);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      // A new URL never inherits the old token: it could be a different host.
      Object.assign(patch, {
        updateWebhookUrl: v.url,
        updateWebhookToken: patch.updateWebhookToken ?? "",
        updateWebhookLastResult: null,
      });
    }
  }
  const settings = await updateSettings(patch);
  return NextResponse.json({ webhook: hookState(settings) }, { headers: NO_STORE });
}
