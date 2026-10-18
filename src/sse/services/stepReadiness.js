import { getProviderConnections } from "@/lib/localDb";
import { isModelLockActive, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getModelInfo } from "./model.js";

/**
 * Cheap readiness of one combo step ("provider/model" or a nested combo name),
 * from the connection rows only (no upstream calls):
 * - combo:    a nested combo (it checks its own steps)
 * - ready:    at least one active account that isn't locked for this model
 * - cooling:  every active account is locked for this model; `until` = first unlock
 * - off:      no active account for this provider
 * - unknown:  the step doesn't resolve to a provider
 */
export async function getStepReadiness(step) {
  const info = await getModelInfo(step).catch(() => null);
  if (!info) return { state: "unknown", accounts: 0, ready: 0, until: null };
  if (!info.provider) return { state: "combo", accounts: 0, ready: 0, until: null };
  const providerId = resolveProviderId(info.provider);
  if (FREE_PROVIDERS[providerId]?.noAuth) return { state: "ready", provider: providerId, accounts: 1, ready: 1, until: null };
  const conns = await getProviderConnections({ provider: providerId, isActive: true });
  if (!conns.length) return { state: "off", provider: providerId, accounts: 0, ready: 0, until: null };
  const ready = conns.filter((c) => !isModelLockActive(c, info.model)).length;
  let until = null;
  if (!ready) {
    const key = getModelLockKey(info.model);
    for (const c of conns) {
      const t = [c[key], c[MODEL_LOCK_ALL]].filter(Boolean).map((v) => new Date(v).getTime()).filter((n) => n > Date.now());
      for (const n of t) if (!until || n < until) until = n;
    }
  }
  return {
    state: ready ? "ready" : "cooling",
    provider: providerId,
    accounts: conns.length,
    ready,
    until: until ? new Date(until).toISOString() : null,
  };
}

/** For the combo engine: false only when the step is known to be down. */
export async function isStepReady(step) {
  const r = await getStepReadiness(step);
  return r.state !== "cooling" && r.state !== "off";
}
