"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "inverse" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "group/primary rounded-full bg-accent text-accent-fg shadow-warm hover:bg-accent-hover",
  secondary:
    "border border-border-strong bg-surface text-text hover:bg-surface-2 dark:border-border",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text",
  inverse: "bg-inverse text-inverse-fg hover:opacity-90",
  danger: "border border-danger-border bg-danger-soft text-danger-text hover:bg-danger/15",
};
// Primary is a pill ending in an arrow chip: tighter right padding hugs the chip.
const PRIMARY_SIZES: Record<Size, string> = { sm: "!pr-1", md: "!pr-1.5" };
const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-9 gap-2 rounded-lg px-4 text-[13px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: string;
  trailingIcon?: string;
  loading?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "sm",
    icon,
    trailingIcon,
    loading,
    disabled,
    className,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  const iconSize = size === "sm" ? 16 : 18;
  const pill = variant === "primary" && !!children;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition-colors",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        variant === "primary" && "rounded-full",
        pill && PRIMARY_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="progress_activity" size={iconSize} className="animate-spin" />
      ) : (
        icon && !pill && <Icon name={icon} size={iconSize} />
      )}
      {children}
      {pill ? (
        <span
          aria-hidden
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-accent-fg/20 transition-transform group-hover/primary:translate-x-0.5",
            size === "sm" ? "size-6" : "size-7",
          )}
        >
          <Icon name={trailingIcon ?? "arrow_forward"} size={iconSize - 2} />
        </span>
      ) : (
        trailingIcon && <Icon name={trailingIcon} size={iconSize - 1} />
      )}
    </button>
  );
});

/** Square icon-only button. Always pass `label` — it becomes the tooltip and aria-label. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "children" | "icon"> & { icon: string; label: string }
>(function IconButton({ icon, label, variant = "ghost", size = "sm", className, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn(size === "sm" ? "w-8 px-0" : "w-9 px-0", className)}
      icon={icon}
      {...rest}
    />
  );
});
