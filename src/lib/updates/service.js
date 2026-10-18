// Background update check: refreshes the release list and, when a redeploy hook
// is configured, calls it once for a newer release on the followed channel.
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { currentVersion, findUpdate, getReleases, updateCheckEnabled } from "./releases.js";
import { sendWebhook, shouldFire } from "./webhook.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // the release list itself is cached ~24h
const g = (globalThis.__regentUpdateService ??= { timer: null, running: false });

export async function runUpdateCheck({ deps = {} } = {}) {
  const {
    getReleasesFn = getReleases,
    getSettingsFn = getSettings,
    updateSettingsFn = updateSettings,
    send = sendWebhook,
    current = currentVersion(),
  } = deps;
  if (g.running) return null;
  g.running = true;
  try {
    const releases = await getReleasesFn();
    const settings = await getSettingsFn();
    const channel = settings.updateWebhookChannel === "any" ? "any" : "major";
    const update = findUpdate(releases, current, channel);
    if (
      !shouldFire({
        url: settings.updateWebhookUrl,
        current,
        candidate: update?.version,
        channel,
        lastVersion: settings.updateWebhookLastVersion,
      })
    )
      return null;
    // Record before sending: a crash mid-call must not lead to a second call.
    await updateSettingsFn({ updateWebhookLastVersion: update.version });
    const result = await send(
      settings.updateWebhookUrl,
      { version: update.version, current },
      { token: settings.updateWebhookToken || "" },
    );
    await updateSettingsFn({ updateWebhookLastResult: result });
    console.log(
      `[Updates] redeploy hook for v${update.version}: ${result.ok ? "sent" : result.error}`,
    );
    return result;
  } catch (e) {
    console.warn("[Updates] check failed:", e?.message || e);
    return null;
  } finally {
    g.running = false;
  }
}

export function startUpdateChecks() {
  if (g.timer || !updateCheckEnabled()) return;
  void runUpdateCheck();
  g.timer = setInterval(() => void runUpdateCheck(), INTERVAL_MS);
  g.timer.unref?.();
}
