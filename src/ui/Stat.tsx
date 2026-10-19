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
export function StatGrid({
  items,
  className,
  compactOnMobile = false,
}: {
  items: StatItem[];
  className?: string;
  /** Below md: four dense columns with smaller values (for drawers and narrow panels). */
  compactOnMobile?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border",
        items.length % 4 === 0 && "xl:grid-cols-4",
        items.length % 3 === 0 && "sm:grid-cols-3",
        compactOnMobile && "max-md:grid-cols-4 max-md:rounded-xl",
        className,
      )}
    >
      {items.map((s) => (
        <div
          key={s.label}
          className={cn("min-w-0 bg-surface p-5", compactOnMobile && "max-md:p-2.5")}
        >
          <div
            className={cn(
              "text-[11px] font-medium uppercase tracking-wider text-text-muted",
              compactOnMobile && "max-md:text-[10px] max-md:leading-tight max-md:tracking-normal",
            )}
          >
            {s.label}
          </div>
          <div
            className={cn(
              "mt-1 text-3xl font-semibold tabular-nums",
              compactOnMobile && "max-md:mt-0.5 max-md:truncate max-md:text-base",
              s.tone === "danger" && Number(s.value) > 0 && "text-danger-text",
            )}
          >
            {typeof s.value === "number" ? <LiveNumber value={s.value} /> : s.value}
          </div>
          {s.sub && (
            <div
              className={cn(
                "text-xs text-text-muted",
                compactOnMobile && "max-md:truncate max-md:text-[10px]",
              )}
            >
              {s.sub}
            </div>
          )}
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
