"use client";

import { cn } from "./cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** Mutually exclusive choice between 2–4 options (scope, mode, format). */
export function Segmented<T extends string>({ value, onChange, options, className, size = "sm" }: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="radiogroup"
      className={cn("grid rounded-lg bg-surface-2 p-0.5 text-xs", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "truncate rounded-md px-2 transition-colors",
            size === "sm" ? "h-7" : "h-8",
            value === o.value ? "bg-surface font-medium text-text shadow-sm dark:bg-surface-3" : "text-text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
