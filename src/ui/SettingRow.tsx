"use client";

import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { Panel } from "./Panel";
import { Skeleton } from "./Skeleton";
import { cn } from "./cn";

/** One setting: label + explanation on the left, control on the right (or below when `stack`). */
export function SettingRow({
  title,
  hint,
  children,
  stack,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  stack?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-x-6 gap-y-3 py-4",
        stack ? "flex-col" : "flex-col sm:flex-row sm:items-start sm:justify-between",
      )}
    >
      <div className="min-w-0 sm:max-w-md">
        <div className="text-[13px] font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{hint}</div>}
      </div>
      {children && <div className={cn("min-w-0", !stack && "sm:shrink-0")}>{children}</div>}
    </div>
  );
}

export function SettingsSection({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="mb-2 flex items-center gap-2 font-display text-xl">
        <Icon name={icon} size={20} className="text-text-muted" />
        {title}
      </h2>
      <Panel className="divide-y divide-border px-5">{children}</Panel>
    </section>
  );
}

export function SettingRowSkeleton() {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-64" />
      </div>
      <Skeleton className="h-5 w-9 rounded-full" />
    </div>
  );
}

export function Note({
  tone,
  children,
}: {
  tone: "success" | "danger" | "warning";
  children: ReactNode;
}) {
  const cls = {
    success: "text-success-text",
    danger: "text-danger-text",
    warning: "text-warning-text",
  }[tone];
  const icon = { success: "check_circle", danger: "error", warning: "warning" }[tone];
  return (
    <p className={cn("flex items-start gap-1.5 text-[12px]", cls)}>
      <Icon name={icon} size={14} filled className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}
