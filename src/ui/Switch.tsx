"use client";

import { cn } from "./cn";

/** On/off switch. Stops click propagation so it can sit inside clickable rows. */
export function Switch({ checked, onChange, label, disabled, className }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50",
        checked ? "bg-success" : "bg-surface-3",
        className,
      )}
    >
      <span className={cn("size-3.5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[15px]" : "translate-x-0.5")} />
    </button>
  );
}
