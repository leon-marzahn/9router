"use client";

import { useEffect, useRef, type RefObject } from "react";

export interface ListKeyboardOptions {
  /** Row ids in display order. */
  order: string[];
  /** The selected row id, or null on the overview. */
  selected: string | null;
  /** Move to a row, or back to the overview with null. */
  onSelect: (id: string | null) => void;
  /** Focused by `/`. */
  searchRef?: RefObject<HTMLInputElement | null>;
  /** Called on Enter while a row is selected (e.g. open its full page). */
  onEnter?: (id: string) => void;
}

/**
 * Workbench list keys: ↑/↓ or j/k move, `/` focuses search, Esc returns to the
 * overview, Enter calls `onEnter`. Ignored while a modal is open; inside a field
 * only Esc is handled (it blurs the field).
 */
export function useListKeyboard(opts: ListKeyboardOptions) {
  const ref = useRef(opts);
  useEffect(() => {
    ref.current = opts;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys belong to an open dialog (e.g. Esc closes it), not to the workbench
      if (document.querySelector("[aria-modal=true]")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { order, selected, onSelect, searchRef, onEnter } = ref.current;
      const i = selected ? order.indexOf(selected) : -1;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        onSelect(order[Math.min(i + 1, order.length - 1)] ?? null);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        onSelect(order[Math.max(i - 1, 0)] ?? null);
      } else if (e.key === "/" && searchRef) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") onSelect(null);
      else if (e.key === "Enter" && selected && onEnter) onEnter(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
