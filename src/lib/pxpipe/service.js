import { getInstallInfo, isInstalling, findNpm, verifyInstall } from "./install.js";
import { clearPinFailure, getLoadedInfo, getUnavailableReason, loadPxpipe, rememberPinFailure, selfTest } from "./loader.js";
import { PXPIPE_VERSION } from "./pin.js";

// Aggregate status for the Token Saver card and /api/pxpipe/status.
// "running" in library mode = module loaded into this process.
export function getPxpipeStatus() {
  const install = getInstallInfo();
  const loaded = getLoadedInfo();
  return {
    installed: install.installed,
    installing: isInstalling(),
    version: install.version,
    pinnedVersion: PXPIPE_VERSION,
    // Only a failure already seen by a load/health run; status never re-hashes.
    pinMismatch: getUnavailableReason() === "pin_mismatch",
    path: install.path,
    running: loaded.loaded,
    loadedAt: loaded.loadedAt || null,
    uptimeMs: loaded.loaded ? Date.now() - loaded.loadedAt : 0,
    npmAvailable: !!findNpm(),
    mode: "library", // in-process transform, not an external proxy
  };
}

// PRD health checklist, adapted to library mode: installed? → module loads
// (the "executable found / port listening" equivalent) → test request transforms.
export async function runHealthCheck() {
  const checks = [];
  const fail = (error, code = null) => ({ healthy: false, checks, error, code, pinnedVersion: PXPIPE_VERSION });

  const install = getInstallInfo();
  checks.push({ id: "installed", label: "PXPIPE installed", ok: install.installed, detail: install.version ? `v${install.version}` : null });
  if (!install.installed) return fail("pxpipe not installed", "NOT_INSTALLED");

  // Re-verified on every health run, so a copy changed on disk after it was
  // loaded is also caught and dropped from the request path.
  clearPinFailure();
  const pin = verifyInstall();
  checks.push({ id: "pinned", label: `Matches pinned release v${PXPIPE_VERSION}`, ok: pin.ok, detail: pin.reason });
  if (!pin.ok) {
    // Drops a loaded module and makes requests skip without re-hashing.
    rememberPinFailure(pin.reason);
    return fail("Installed copy does not match the pinned release. Reinstall the pinned version.", "PIN_MISMATCH");
  }

  try {
    await loadPxpipe();
    checks.push({ id: "module", label: "Transform module loads", ok: true, detail: `v${install.version}` });
  } catch (e) {
    checks.push({ id: "module", label: "Transform module loads", ok: false, detail: e.message });
    return fail(`Cannot load module: ${e.message}`);
  }

  try {
    const test = await selfTest();
    checks.push({ id: "transform", label: "Test request transforms", ok: true, detail: `${test.durationMs}ms (${test.reason})` });
  } catch (e) {
    checks.push({ id: "transform", label: "Test request transforms", ok: false, detail: e.message });
    return fail(`Self-test failed: ${e.message}`);
  }

  return { healthy: true, checks, error: null, code: null, pinnedVersion: PXPIPE_VERSION };
}
