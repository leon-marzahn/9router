"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

/**
 * Checkbox: a 16px box to look at; the label's ::after stretches the tap target
 * to 40px (same pattern as Switch). Pass `label` for a visible caption, or
 * `aria-label` for a bare row checkbox.
 */
export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: ReactNode }) {
  return (
    <label
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center gap-2",
        label == null ? "after:absolute after:-inset-3" : "max-md:min-h-10",
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...rest} />
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded border border-border-strong bg-surface text-transparent transition-colors",
          "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-accent-fg",
          "peer-focus-visible:shadow-focus peer-disabled:opacity-50",
        )}
      >
        <Icon name="check" size={13} />
      </span>
      {label}
    </label>
  );
}
