"use client";

import { useNotificationStore } from "@/store/notificationStore";
import { Icon } from "../Icon";
import { cn } from "../cn";

const TONE: Record<string, { cls: string; icon: string }> = {
  success: { cls: "text-success-text", icon: "check_circle" },
  error: { cls: "text-danger-text", icon: "error" },
  warning: { cls: "text-warning-text", icon: "warning" },
  info: { cls: "text-info-text", icon: "info" },
};

interface Toast {
  id: string;
  type?: string;
  title?: string;
  message: string;
  dismissible?: boolean;
}

export function Toasts() {
  const notifications = useNotificationStore((s: { notifications: Toast[] }) => s.notifications);
  const remove = useNotificationStore(
    (s: { removeNotification: (id: string) => void }) => s.removeNotification,
  );
  return (
    <div
      aria-live="polite"
      className="fixed right-4 top-4 z-[110] flex w-[min(92vw,380px)] flex-col gap-2"
    >
      {notifications.map((n) => {
        const tone = TONE[n.type ?? "info"] ?? TONE.info;
        return (
          <div
            key={n.id}
            className="slide-in-top rounded-xl border border-border bg-surface px-3 py-2.5 shadow-elev"
          >
            <div className="flex items-start gap-2.5">
              <Icon name={tone.icon} size={18} className={cn("mt-px", tone.cls)} />
              <div className="min-w-0 flex-1 text-[13px]">
                {n.title && <p className="mb-0.5 font-semibold">{n.title}</p>}
                <p className="whitespace-pre-wrap break-words text-text-muted">{n.message}</p>
              </div>
              {n.dismissible && (
                <button
                  type="button"
                  onClick={() => remove(n.id)}
                  aria-label="Dismiss"
                  className="text-text-subtle hover:text-text"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
