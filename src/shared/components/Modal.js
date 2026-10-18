"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/cn";
import Button from "./Button";

/**
 * @param {{ isOpen: boolean, onClose: () => void, title?: any, children?: any, footer?: any, size?: string, closeOnOverlay?: boolean, showTrafficLights?: boolean, className?: string }} props
 */
export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  // eslint-disable-next-line no-unused-vars -- kept for API compatibility
  showTrafficLights,
  className,
}) {
  const sizes = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-4xl",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  // Portal to body so a dimmed/transformed ancestor (e.g. an inactive row) can't fade or clip the dialog.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <div className="fade-in absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeOnOverlay ? onClose : undefined} />
      <div
        className={cn(
          "fade-in relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-[13px] text-text shadow-elev",
          sizes[size],
          className,
        )}
      >
        {title && (
          <div className="flex shrink-0 items-start gap-3 px-5 pb-1 pt-5">
            <h2 className="min-w-0 flex-1 font-display text-xl leading-tight tracking-tight">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 px-5 pb-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * @param {{ confirmIcon?: string } & Record<string, any>} props
 */
export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
  confirmIcon,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} icon={confirmIcon}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-text-muted">{message}</p>
    </Modal>
  );
}
