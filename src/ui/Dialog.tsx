"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { cn } from "./cn";
import { Icon } from "./Icon";

const SIZES = { sm: "md:max-w-sm", md: "md:max-w-md", lg: "md:max-w-lg", xl: "md:max-w-xl" };

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Controls that open the on-screen keyboard when focused. */
const TEXT_ENTRY =
  "input:not([type=hidden],[type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=range],[type=color],[type=file],[disabled],[readonly]),textarea:not([disabled],[readonly]),[contenteditable]:not([contenteditable=false])";

/**
 * Whether opening a dialog may focus its first field: only with a mouse/trackpad
 * (hover + fine pointer). On touch the dialog is a bottom sheet, and a focused
 * field would pop the keyboard over it.
 */
export function fieldAutofocus(): boolean {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}

/**
 * The one initial-focus rule for every dialog. With a fine pointer: a
 * `[data-autofocus]` element, else the first text field in the body, else the
 * first focusable body control, else the panel. On touch: `[data-autofocus]`
 * unless it is a text field, else the panel itself (Esc and screen readers still
 * land in the dialog, no keyboard pops). Use `data-autofocus`, never `autoFocus`.
 */
export function initialFocus(panel: HTMLElement, fields: boolean): HTMLElement {
  const marked = panel.querySelector<HTMLElement>("[data-autofocus]");
  const isText = (el: Element) => el.matches(TEXT_ENTRY) || !!el.querySelector(TEXT_ENTRY);
  if (!fields) return marked && !isText(marked) ? marked : panel;
  return (
    marked ??
    panel.querySelector<HTMLElement>(`[data-dialog-body] :is(${TEXT_ENTRY})`) ??
    panel.querySelector<HTMLElement>(`[data-dialog-body] :is(${FOCUSABLE})`) ??
    panel
  );
}

/** Open dialog panels, innermost last: only the top one handles Esc / Tab, so a picker opened from a dialog neither closes its parent nor has focus pulled back into it. */
const openStack: HTMLElement[] = [];

/**
 * Modal dialog: centered card on md+, bottom sheet below md. Traps Tab focus,
 * closes on Esc / scrim click (unless `dismissible` is false), locks page scroll
 * and returns focus to whatever was focused when it opened.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  dismissible = true,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** false while a request is in flight: Esc, scrim and × stay inert. */
  dismissible?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  const dismissRef = useRef(dismissible);
  useEffect(() => {
    closeRef.current = onClose;
    dismissRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) initialFocus(panel, fieldAutofocus()).focus();
    if (panel) openStack.push(panel);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (panel && openStack[openStack.length - 1] !== panel) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (dismissRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0];
      const z = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === a || cur === panel)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (cur === z || !panel.contains(cur))) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (panel && openStack.includes(panel)) openStack.splice(openStack.indexOf(panel), 1);
      document.body.style.overflow = prevOverflow;
      returnTo?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center md:items-center md:p-4">
      <div
        aria-hidden="true"
        className="fade-in absolute inset-0 bg-scrim backdrop-blur-sm"
        onClick={() => dismissible && onClose()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "fade-in relative flex max-h-[88dvh] w-full flex-col overflow-hidden border border-border bg-surface text-[13px] text-text shadow-elev outline-none",
          "rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)] md:rounded-2xl md:border-b md:pb-0",
          SIZES[size],
          className,
        )}
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pb-1 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-display text-xl leading-tight tracking-tight">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-text-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            aria-label="Close"
            className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center max-md:size-10 rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {children != null && (
          <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>
        )}
        {footer && (
          <div className="flex shrink-0 flex-col-reverse gap-2 px-5 pb-5 pt-2 md:flex-row md:items-center md:justify-end [&>button]:justify-center">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Yes/no confirmation. Confirm is never the initially focused control, so a stray
 * Enter can't trigger the action; while `loading` it can't be dismissed.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  confirmIcon,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary";
  confirmIcon?: string;
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={message}
      size="sm"
      dismissible={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading} data-autofocus>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} icon={confirmIcon}>
            {confirmText}
          </Button>
        </>
      }
    />
  );
}
