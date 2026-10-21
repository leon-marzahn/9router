import type { Span } from "./ResetTimeline";

export type Sel = { kind: "provider" | "account"; id: string } | null;

export const RANGE_TO_SPAN: Record<string, Span> = { "6h": 6, "24h": 24, "7d": 168 };
export const SPAN_TO_RANGE: Record<Span, string> = { 6: "6h", 24: "24h", 168: "7d" };

/** Pre-fix key that made a bare /dashboard/quota reopen the last selection. */
export const LEGACY_LAST_VIEW_KEY = "regent.quotaUrl.v1";

/**
 * The Quota Tracker's view comes from the URL only. A bare URL (entering from
 * the nav) is the default overview; ?account= / ?provider= deep-link a selection,
 * ?range= picks the timeline span, ?view=overview is the mobile overview screen.
 */
export function quotaViewFromParams(params: { get(name: string): string | null }): {
  sel: Sel;
  span: Span;
  overview: boolean;
} {
  const account = params.get("account");
  const provider = params.get("provider");
  const sel: Sel = account
    ? { kind: "account", id: account }
    : provider
      ? { kind: "provider", id: provider }
      : null;
  return {
    sel,
    span: RANGE_TO_SPAN[params.get("range") ?? ""] ?? 24,
    overview: !sel && params.get("view") === "overview",
  };
}
