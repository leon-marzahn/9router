import { getProviderByAlias } from "@/shared/constants/providers.js";
import type { Status } from "@/ui";
import type { StepReadiness } from "./useCombos";

export type StepTone = "ready" | "cooling" | "off" | "combo" | "unknown";

export const STEP_LABEL: Record<StepTone, string> = {
  ready: "Ready",
  cooling: "Cooling down",
  off: "No account",
  combo: "Combo",
  unknown: "Unknown",
};

/** Step tones on the shared status vocabulary (docs/DESIGN.md "Status"). */
export const STEP_STATUS: Record<StepTone, Status> = {
  ready: "ok",
  cooling: "degraded",
  off: "error",
  combo: "ready",
  unknown: "none",
};

type ProviderInfo = { id?: string; name?: string } | null;

/** "cc/claude-opus" -> provider id + display name + model part. */
export function splitStep(step: string, r?: StepReadiness) {
  if (!step.includes("/"))
    return { providerId: "combo", providerName: "Combo", model: step, isCombo: true };
  const [alias, ...rest] = step.split("/");
  const p = getProviderByAlias(alias) as ProviderInfo;
  const providerId = r?.provider || p?.id || alias;
  return { providerId, providerName: p?.name || providerId, model: rest.join("/"), isCombo: false };
}

export function untilText(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function stepDetail(r: StepReadiness | undefined, now = Date.now()) {
  if (!r) return "";
  if (r.state === "cooling")
    return r.until
      ? `all accounts resting · back in ${untilText(r.until, now)}`
      : "all accounts resting";
  if (r.state === "off") return "no active account";
  if (r.state === "ready")
    return r.accounts > 1 ? `${r.ready} of ${r.accounts} accounts ready` : "";
  if (r.state === "combo") return "routes through another combo";
  return "not a known provider";
}
