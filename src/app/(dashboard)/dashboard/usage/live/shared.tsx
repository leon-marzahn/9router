// Small chart pieces for the Usage page, drawn with the theme's tokens.
"use client";

import { useId } from "react";
import { cn } from "@/ui/cn";
import { fmtCost, fmtTokens, type ChartPoint } from "./useUsage";

export type Metric = "requests" | "tokens" | "cost" | "credits";

export const fmtMetric = (m: Metric, v: number) =>
  m === "cost"
    ? fmtCost(v)
    : m === "tokens"
      ? fmtTokens(v)
      : m === "credits"
        ? v.toFixed(1)
        : Math.round(v).toLocaleString();

/** Area chart over the period's buckets. */
export function AreaChart({
  points,
  metric,
  height = 180,
  className,
}: {
  points: ChartPoint[];
  metric: Metric;
  height?: number;
  className?: string;
}) {
  const id = useId();
  const W = 600;
  const values = points.map((p) => p[metric] ?? 0);
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const xy = values.map((v, i) => [i * step, height - 8 - (v / max) * (height - 24)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${height} L0 ${height} Z`;
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        role="img"
        aria-label={`${metric} over time, peak ${fmtMetric(metric, max)}`}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={height * f}
            y2={height * f}
            stroke="var(--color-border)"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} fill={`url(#${id})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-text-subtle">
        {points.map((p, i) =>
          i % labelEvery === 0 || i === points.length - 1 ? <span key={i}>{p.label}</span> : null,
        )}
      </div>
      <div className="pointer-events-none absolute right-0 top-0 text-[10px] tabular-nums text-text-subtle">
        peak {fmtMetric(metric, max)}
      </div>
    </div>
  );
}

/** Tiny bar sparkline; the newest bucket is drawn solid. */
export function Spark({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(...values, 1);
  return (
    <div className={cn("flex h-8 items-end gap-0.5", className)} aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cn(
            "flex-1 rounded-sm",
            i === values.length - 1 ? "bg-accent" : "bg-accent/35",
          )}
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** Horizontal share bar. */
export function ShareBar({ share, className }: { share: number; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-surface-3", className)}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${Math.max(2, share * 100)}%` }}
      />
    </div>
  );
}
