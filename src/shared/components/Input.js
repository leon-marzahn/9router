"use client";

import { cn } from "@/ui/cn";

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  ...props
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-xs font-medium text-text">
          {label}
          {required && <span className="ml-0.5 text-danger-text">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" style={{ fontSize: 17 }}>
            {icon}
          </span>
        )}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          className={cn(
            "h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-[16px] text-text outline-none transition-colors sm:text-[13px] dark:border-border",
            "placeholder:text-text-subtle focus:border-accent focus:shadow-focus disabled:cursor-not-allowed disabled:opacity-50",
            icon && "pl-9",
            error && "border-danger focus:border-danger",
            inputClassName,
          )}
          {...props}
        />
      </div>
      {error ? (
        <p className="text-[11px] text-danger-text">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
