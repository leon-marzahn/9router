"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Side tooltip for the icon rail. Fixed-positioned in a portal so the rail can
 * scroll without clipping it. Shows on hover and on keyboard focus.
 */
export function RailTooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 10 });
  };
  return (
    <div
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setPos(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setPos(null)}
      onClick={() => setPos(null)}
    >
      {children}
      {pos && typeof document !== "undefined" &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
            className="pointer-events-none fixed z-[95] -translate-y-1/2 whitespace-nowrap rounded-md bg-inverse px-2 py-1 text-xs text-inverse-fg shadow-lg"
          >
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
}
