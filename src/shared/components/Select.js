"use client";

import { useId } from "react";
import { cn } from "@/ui/cn";

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  ...props
}) {
  const autoId = useId();
  const id = props.id ?? autoId;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-text">
          {label}
          {required && <span className="ml-0.5 text-danger-text">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={cn(
            "h-9 max-md:h-10 w-full appearance-none rounded-lg border border-border-strong bg-surface pl-3 pr-9 text-[16px] text-text outline-none transition-colors sm:text-[13px] dark:border-border",
            "focus:border-accent focus:shadow-focus disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-danger focus:border-danger",
            selectClassName,
          )}
          {...props}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="material-symbols-outlined pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-subtle" style={{ fontSize: 18 }}>
          expand_more
        </span>
      </div>
      {error ? (
        <p className="text-[11px] text-danger-text">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
