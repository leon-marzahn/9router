"use client";

import { cn } from "@/ui/cn";

const variants = {
  default: "bg-surface-2 text-text-muted",
  primary: "bg-accent-soft text-accent-text",
  success: "bg-success/12 text-success-text",
  warning: "bg-warning/12 text-warning-text",
  error: "bg-danger/10 text-danger-text",
  info: "bg-info/12 text-info-text",
};

const dots = {
  default: "bg-text-subtle",
  primary: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
  info: "bg-info",
};

const sizes = {
  sm: "px-1.5 py-px text-[10px]",
  md: "px-2 py-0.5 text-[11px]",
  lg: "px-2.5 py-1 text-xs",
};

export default function Badge({ children, variant = "default", size = "md", dot = false, icon, className }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded font-medium", variants[variant] || variants.default, sizes[size] || sizes.md, className)}>
      {dot && <span className={cn("size-1.5 rounded-full", dots[variant] || dots.default)} />}
      {icon && <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>{icon}</span>}
      {children}
    </span>
  );
}
