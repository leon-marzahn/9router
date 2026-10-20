import type { ReactNode, Ref } from "react";
import { cn } from "./cn";
import { CopyButton } from "./CopyButton";
import { Panel } from "./Panel";

/**
 * Code or log output in a Panel: optional header strip (title, meta, actions,
 * `copy`) over a sunken `bg-bg-alt` body. Pass `text` for a plain `<pre>`, or
 * `children` for a custom body.
 */
export function CodeBlock({
  title,
  meta,
  actions,
  copy,
  copyLabel,
  text,
  wrap,
  muted,
  children,
  className,
  preClassName,
  preRef,
  label,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Value the header CopyButton puts on the clipboard (may differ from the shown text). */
  copy?: string;
  copyLabel?: string;
  text?: ReactNode;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  muted?: boolean;
  children?: ReactNode;
  className?: string;
  /** Overrides for the `<pre>` (max height, ref-free tweaks). */
  preClassName?: string;
  preRef?: Ref<HTMLPreElement>;
  /** Accessible name of the scrollable body; defaults to a string `title`. */
  label?: string;
}) {
  const header = title != null || meta != null || actions != null || copy != null;
  return (
    <Panel className={cn("overflow-hidden", className)}>
      {header && (
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5 text-[12px] text-text-muted">
          {title != null && <span className="font-medium text-text">{title}</span>}
          {meta}
          <div className="ml-auto flex items-center gap-1">
            {actions}
            {copy != null && <CopyButton value={copy} label={copyLabel} />}
          </div>
        </div>
      )}
      <div className={cn("bg-bg-alt", header && "border-t border-border")}>
        {children}
        {text != null && (
          <pre
            ref={preRef}
            // Scrollable, so it must be reachable by keyboard (axe scrollable-region-focusable).
            tabIndex={0}
            aria-label={label ?? (typeof title === "string" ? title : "Code")}
            className={cn(
              "overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed focus-visible:outline-none focus-visible:shadow-focus",
              wrap && "whitespace-pre-wrap break-all",
              muted ? "text-text-muted" : "text-text",
              children != null && "border-t border-border",
              preClassName,
            )}
          >
            {text}
          </pre>
        )}
      </div>
    </Panel>
  );
}
