"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { LiveNumber } from "./live/LiveNumber";

export interface StatItem {
  label: string;
  value: number | string;
  sub?: ReactNode;
  tone?: "danger";
}

/** Large KPI grid (overview pages). Numbers animate when they change. */
export function StatGrid({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border",
        items.length % 4 === 0 && "xl:grid-cols-4",
        items.length % 3 === 0 && "sm:grid-cols-3",
        className,
      )}
    >
      {items.map((s) => (
        <div key={s.label} className="bg-surface p-5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
            {s.label}
          </div>
          <div
            className={cn(
              "mt-1 text-3xl font-semibold tabular-nums",
              s.tone === "danger" && Number(s.value) > 0 && "text-danger-text",
            )}
          >
            {typeof s.value === "number" ? <LiveNumber value={s.value} /> : s.value}
          </div>
          {s.sub && <div className="text-xs text-text-muted">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Inline KPI for the top bar strip: **12** live */
export function InlineStat({
  value,
  label,
  tone,
  onClick,
}: {
  value: number;
  label: ReactNode;
  tone?: "danger" | "success";
  onClick?: () => void;
}) {
  const body = (
    <>
      {tone && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            tone === "danger" && value > 0 ? "bg-danger" : "bg-success",
          )}
        />
      )}
      <b
        className={cn(
          "tabular-nums text-text",
          tone === "danger" && value > 0 && "text-danger-text",
        )}
      >
        <LiveNumber value={value} />
      </b>
      {label}
    </>
  );
  const cls = "flex items-center gap-1.5 whitespace-nowrap text-xs text-text-muted";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "hover:text-text")}>
      {body}
    </button>
  ) : (
    <span className={cls}>{body}</span>
  );
}
