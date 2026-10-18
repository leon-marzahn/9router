/**
 * The one status vocabulary for the whole UI. Every health indicator
 * (provider, connection, combo, pipeline, tunnel…) maps onto these.
 * See docs/DESIGN.md "Status".
 */
export type Status = "ok" | "degraded" | "error" | "paused" | "ready" | "none" | "pending";

export const STATUS: Record<Status, { label: string; dot: string; text: string }> = {
  ok: { label: "Healthy", dot: "bg-success", text: "text-success-text" },
  degraded: { label: "Degraded", dot: "bg-warning", text: "text-warning-text" },
  error: { label: "Failing", dot: "bg-danger", text: "text-danger-text" },
  paused: { label: "Paused", dot: "bg-paused", text: "text-text-muted" },
  ready: { label: "Ready", dot: "bg-info", text: "text-info-text" },
  none: {
    label: "Not connected",
    dot: "bg-transparent ring-1 ring-inset ring-text-subtle",
    text: "text-text-muted",
  },
  pending: { label: "Checking", dot: "bg-text-subtle animate-pulse", text: "text-text-muted" },
};

/** Sort order for lists: problems first, unconfigured last. */
export const STATUS_ORDER: Record<Status, number> = {
  error: 0,
  degraded: 1,
  pending: 2,
  ok: 3,
  ready: 4,
  paused: 5,
  none: 6,
};

export const needsAttention = (s: Status) => s === "error" || s === "degraded";
