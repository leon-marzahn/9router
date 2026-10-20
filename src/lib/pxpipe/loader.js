import { pathToFileURL } from "url";
import { getInstallInfo, libraryEntry, verifyInstall } from "./install.js";

// Module cache: pxpipe is loaded once per process ("started") and dropped on
// "stop". In library mode start/stop govern the in-process module, not a daemon.
let cached = null; // { module, version, loadedAt }
let loadPromise = null;
// A failed pin check is remembered until the next install or health run, so a
// mismatched copy isn't re-hashed (~16 MB, synchronously) on every request.
let pinFailure = null; // Error with code PIN_MISMATCH
// Bumped per import so a re-load after reinstall gets a fresh module URL.
let loadCounter = 0;

export function clearPinFailure() {
  pinFailure = null;
}

export function rememberPinFailure(reason) {
  const err = new Error(`PXPIPE install does not match the pinned release (${reason}) — reinstall the pinned version`);
  err.code = "PIN_MISMATCH";
  pinFailure = err;
  cached = null;
  return err;
}

// Why getTransform() would return null, for request logs: "pin_mismatch" or null.
export function getUnavailableReason() {
  return pinFailure ? "pin_mismatch" : null;
}

export function getLoadedInfo() {
  return cached ? { loaded: true, version: cached.version, loadedAt: cached.loadedAt } : { loaded: false };
}

export async function loadPxpipe() {
  if (cached) return cached;
  if (loadPromise) return loadPromise;
  loadPromise = doLoad().finally(() => { loadPromise = null; });
  return loadPromise;
}

async function doLoad() {
  const info = getInstallInfo();
  if (!info.installed) {
    const err = new Error("PXPIPE is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  // Never import a copy that isn't the pinned, reviewed release: it would run
  // in-process and see prompts. Reinstalling is an explicit user action.
  if (pinFailure) throw pinFailure;
  const pin = verifyInstall();
  if (!pin.ok) throw rememberPinFailure(pin.reason);
  // A unique URL per import (tree hash + counter) so a load after reinstall or
  // unload doesn't get Node's ESM-cached copy of the old URL. Only the entry
  // file is re-evaluated: its relative imports stay cached for the process, so
  // fully replacing an already-loaded module needs a server restart.
  loadCounter += 1;
  const url = `${pathToFileURL(libraryEntry()).href}?v=${pin.treeSha256}&n=${loadCounter}`;
  const mod = await import(/* webpackIgnore: true */ url);
  if (typeof mod.transformAnthropicMessages !== "function") {
    throw new Error("installed pxpipe package does not export transformAnthropicMessages");
  }
  cached = { module: mod, version: info.version, loadedAt: Date.now() };
  return cached;
}

export function unloadPxpipe() {
  const wasLoaded = !!cached;
  cached = null;
  return wasLoaded;
}

// Transform function for the request pipeline; null when unavailable (fail-open).
// autoLoad controls whether a cold cache triggers a load (first request warms it).
export async function getTransform({ autoLoad = true } = {}) {
  try {
    if (!cached && !autoLoad) return null;
    const { module: mod } = await loadPxpipe();
    return mod.transformAnthropicMessages;
  } catch {
    return null;
  }
}

// Health self-test: run a tiny synthetic Claude request through the transformer.
// A healthy module parses it and answers with a machine-readable reason.
export async function selfTest() {
  const startedAt = Date.now();
  const { module: mod } = await loadPxpipe();
  const body = new TextEncoder().encode(JSON.stringify({
    model: "claude-fable-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  }));
  const result = await mod.transformAnthropicMessages({ body, model: "claude-fable-5" });
  if (!result || typeof result.applied !== "boolean" || !(result.body instanceof Uint8Array)) {
    throw new Error("transform returned an unexpected shape");
  }
  return { ok: true, reason: result.reason, durationMs: Date.now() - startedAt };
}
