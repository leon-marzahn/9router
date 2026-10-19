"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";
import { useFlashOnChange } from "./live/useFlashOnChange";

/**
 * Row in a list pane. Pass `version` (any value that changes when the row's
 * live data changes) to get the live-update flash.
 */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  active,
  onClick,
  version,
  id,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  version?: unknown;
  id?: string;
  className?: string;
}) {
  const flash = useFlashOnChange(version);
  return (
    <button
      type="button"
      data-id={id}
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left max-md:min-h-11 text-[13px] transition-colors",
        active ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
        flash && !active && "animate-live-flash",
        className,
      )}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate", active && "font-medium")}>{title}</div>
        {subtitle && <div className="truncate text-[11px] text-text-muted">{subtitle}</div>}
      </div>
      {trailing}
    </button>
  );
}

export function ListGroup({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count?: number;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <div className="mb-2">
      <div
        className={cn(
          "px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider",
          tone === "danger" ? "text-danger-text" : "text-text-subtle",
        )}
      >
        {title} {count != null && <span className="font-normal opacity-70">{count}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Dashed "Add …" row at the end of a list: the in-list twin of the header's
 * secondary "New" button. The label goes in children ("Add proxy pool").
 */
export function ListAddRow({
  icon = "add",
  onClick,
  disabled,
  className,
  children,
}: {
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-[12px] text-text-muted transition-colors",
        "hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:shadow-focus",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      <Icon name={icon} size={16} className="shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}
