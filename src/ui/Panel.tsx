import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

/** Raised surface. The only "card" in the system. */
export function Panel({
  className,
  interactive,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-surface shadow-soft",
        interactive && "transition hover:-translate-y-0.5 hover:shadow-elevated",
        className,
      )}
      {...rest}
    />
  );
}

/** Section heading inside a page or pane. */
export function SectionTitle({
  icon,
  title,
  count,
  tone,
  action,
  className,
}: {
  icon?: string;
  title: ReactNode;
  count?: number;
  tone?: "danger";
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <h2
        className={cn(
          "flex items-center gap-2 text-base font-semibold",
          tone === "danger" && "text-danger-text",
        )}
      >
        {icon && <Icon name={icon} size={20} />}
        {title}
        {count != null && <span className="text-sm font-normal text-text-subtle">{count}</span>}
      </h2>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** Small uppercase label used for pane sections and table headers. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("text-[11px] font-medium uppercase tracking-wider text-text-muted", className)}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  children,
  action,
  className,
}: {
  icon: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-dashed border-border-strong px-4 py-6 text-text-muted dark:border-border",
        className,
      )}
    >
      <Icon name={icon} size={22} className="text-text-subtle" />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}
