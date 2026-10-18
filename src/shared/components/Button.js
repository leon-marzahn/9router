"use client";

import { cn } from "@/ui/cn";

// Shared (legacy-API) button rendered in the warm-workbench design.
// New code should use Button from "@/ui"; this keeps old call sites consistent.
const variants = {
  primary: "rounded-full bg-accent text-accent-fg shadow-warm hover:bg-accent-hover",
  secondary: "border border-border-strong bg-surface text-text hover:bg-surface-2 dark:border-border",
  outline: "border border-border-strong bg-transparent text-text hover:bg-surface-2 dark:border-border",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text",
  danger: "bg-danger text-white hover:bg-danger/90",
  success: "bg-success text-white hover:bg-success/90",
};

const sizes = {
  xs: "h-7 gap-1 rounded-md px-2.5 text-[11px]",
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-9 gap-2 rounded-lg px-4 text-[13px]",
  lg: "h-10 gap-2 rounded-lg px-5 text-[13px]",
};

const iconSize = { xs: 14, sm: 16, md: 18, lg: 18 };

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  type = "button",
  ...props
}) {
  const glyph = (name, spin) => (
    <span className={cn("material-symbols-outlined leading-none", spin && "animate-spin")} style={{ fontSize: iconSize[size] }}>
      {name}
    </span>
  );
  // Primary is a pill ending in an arrow chip (see docs/DESIGN.md).
  const pill = (variant === "primary" || !variants[variant]) && !!children;
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50",
        variants[variant] || variants.primary,
        sizes[size] || sizes.md,
        pill && "rounded-full !pr-1.5",
        fullWidth && "w-full",
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? glyph("progress_activity", true) : icon && !pill ? glyph(icon) : null}
      {children}
      {pill ? (
        <span aria-hidden className="inline-flex size-6 items-center justify-center rounded-full bg-accent-fg/20">
          {glyph(iconRight || "arrow_forward")}
        </span>
      ) : (
        iconRight && !loading && glyph(iconRight)
      )}
    </button>
  );
}
