"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { Icon } from "./Icon";

type Side = "right" | "bottom-end" | "bottom-start";

function place(anchor: DOMRect, side: Side): React.CSSProperties {
  if (side === "right") return { left: anchor.right + 8, top: anchor.top };
  if (side === "bottom-start") return { left: anchor.left, top: anchor.bottom + 6 };
  return { right: window.innerWidth - anchor.right, top: anchor.bottom + 6 };
}

/**
 * Floating panel anchored to a trigger, rendered in a portal so it escapes
 * overflow clipping (e.g. the scrolling icon rail). Closes on outside click / Esc.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  side = "right",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  side?: Side;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const s = place(anchorRef.current.getBoundingClientRect(), side);
    // keep inside the viewport vertically
    const h = panelRef.current?.offsetHeight ?? 0;
    if (typeof s.top === "number" && s.top + h > window.innerHeight - 8)
      s.top = Math.max(8, window.innerHeight - h - 8);
    setStyle(s);
  }, [open, side, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      style={style}
      className={cn(
        "fixed z-[90] min-w-52 overflow-hidden rounded-xl border border-border bg-surface py-1 text-[13px] shadow-elev fade-in",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  href,
  external,
  danger,
  trailing,
  active,
}: {
  icon?: string;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
  active?: boolean;
}) {
  const cls = cn(
    "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
    danger ? "text-danger-text hover:bg-danger-soft" : "text-text hover:bg-surface-2",
    active && "bg-accent-soft text-accent-text",
  );
  const body = (
    <>
      {icon && <Icon name={icon} size={18} className={danger || active ? "" : "text-text-muted"} />}
      <span className="flex-1 truncate">{children}</span>
      {trailing}
      {external && <Icon name="arrow_outward" size={14} className="text-text-subtle" />}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        onClick={onClick}
        className={cls}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border-subtle" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-text-subtle">
      {children}
    </div>
  );
}
