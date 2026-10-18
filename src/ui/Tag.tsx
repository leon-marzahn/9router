import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "solid-danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-muted",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success/12 text-success-text",
  warning: "bg-warning/12 text-warning-text",
  danger: "bg-danger/10 text-danger-text",
  info: "bg-info/12 text-info-text",
  "solid-danger": "bg-danger text-white",
};

/** Small label. Use `mono` for codes (429, AUTH, model ids). */
export function Tag({
  tone = "neutral",
  mono,
  children,
  className,
  title,
}: {
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium",
        mono && "font-mono font-semibold",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
