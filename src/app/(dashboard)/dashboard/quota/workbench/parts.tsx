"use client";

import { useRef, useState } from "react";
import {
  Button,
  ConfirmDialog,
  IconButton,
  MenuItem,
  MenuSeparator,
  Popover,
  StatusLabel,
} from "@/ui";
import { cn } from "@/ui/cn";
import AutoPingScheduleModal from "@/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal";
import {
  AUTO_PING_KEYS,
  RESETTABLE,
  barTone,
  pctText,
  providerName,
  untilText,
  windowLabel,
  type AutoPing,
  type QuotaAccount,
  type QuotaWindow,
} from "./useQuota";

export interface Actions {
  refreshOne: (id: string) => void;
  setActive: (ids: string[], isActive: boolean) => Promise<void>;
  resetLimit: (a: QuotaAccount) => Promise<void>;
  setHidden: (provider: string, key: string, hide: boolean) => Promise<void>;
  autoPingFor: (a: QuotaAccount) => AutoPing;
  saveAutoPing: (a: QuotaAccount, v: AutoPing) => Promise<void>;
}

const STATUS_WORD: Record<string, string> = {
  ok: "Plenty left",
  degraded: "Running low",
  error: "Exhausted",
  paused: "Turned off",
  ready: "No limits",
  none: "No data",
  pending: "Checking",
};

export const statusWord = (a: QuotaAccount) =>
  a.error && a.isActive ? "Can't read quota" : STATUS_WORD[a.status];

export function AccountStatus({ a }: { a: QuotaAccount }) {
  return <StatusLabel status={a.status} label={statusWord(a)} />;
}

/** One limit: label, bar, what's left, reset countdown. */
export function WindowBar({
  w,
  now,
  size = "md",
  onHide,
}: {
  w: QuotaWindow;
  now: number;
  size?: "sm" | "md";
  onHide?: () => void;
}) {
  const pct = w.remaining;
  return (
    <div className={cn("group/w", size === "sm" ? "space-y-1" : "space-y-1.5")}>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1 truncate",
            size === "sm" ? "text-[11px] text-text-muted" : "text-[13px]",
          )}
        >
          {windowLabel(w.name)}
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              title="Hide this limit for every account of this provider"
              className="invisible text-[10px] text-text-subtle hover:text-text group-hover/w:visible"
            >
              hide
            </button>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            size === "sm" ? "text-[11px]" : "text-[13px] font-medium",
            pct != null && pct <= 5 && "text-danger-text",
          )}
        >
          {pctText(w)}
          {pct != null && <span className="font-normal text-text-subtle"> left</span>}
        </span>
      </div>
      <div
        className={cn("overflow-hidden rounded-full bg-surface-3", size === "sm" ? "h-1" : "h-1.5")}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-700", barTone(pct))}
          style={{
            width: pct == null ? "100%" : `${Math.max(1.5, pct)}%`,
            opacity: pct == null ? 0.35 : 1,
          }}
        />
      </div>
      {size === "md" && (
        <div className="flex justify-between text-[11px] text-text-subtle">
          <span>
            {w.used != null && w.total
              ? `${Math.round(w.used).toLocaleString()} of ${Math.round(w.total).toLocaleString()} used`
              : w.unlimited
                ? "No cap"
                : w.credit
                  ? "Credit balance"
                  : ""}
          </span>
          <span className="tabular-nums">
            {w.resetAt ? `resets in ${untilText(w.resetAt, now)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/** Refresh + menu (auto-ping, reset, routing). Spending actions confirm first. */
export function AccountActions({
  a,
  actions,
  compact,
}: {
  a: QuotaAccount;
  actions: Actions;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "reset" | "routing" | "ping">(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone?: "danger" } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const ping = AUTO_PING_KEYS[a.provider] ? actions.autoPingFor(a) : null;
  const pingOn = !!ping && (ping.reactive || !!ping.schedule);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setNote({ text: done });
    } catch (e) {
      setNote({ text: (e as Error).message, tone: "danger" });
    } finally {
      setBusy(false);
      setDialog(null);
      setTimeout(() => setNote(null), 4000);
    }
  };
  const choose = (d: typeof dialog) => {
    setOpen(false);
    setDialog(d);
  };

  return (
    <div className="flex items-center gap-1.5">
      {note && (
        <span
          className={cn(
            "max-w-56 truncate text-[11px]",
            note.tone === "danger" ? "text-danger-text" : "text-text-muted",
          )}
        >
          {note.text}
        </span>
      )}
      {compact ? (
        <IconButton
          icon="refresh"
          label="Refresh quota"
          onClick={() => actions.refreshOne(a.id)}
          disabled={a.loading}
        />
      ) : (
        <Button
          size="sm"
          icon="refresh"
          loading={a.loading}
          onClick={() => actions.refreshOne(a.id)}
        >
          Refresh
        </Button>
      )}
      <IconButton ref={ref} icon="more_horiz" label="More actions" onClick={() => setOpen(!open)} />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        side="bottom-end"
        className="w-60 py-1"
      >
        {ping && (
          <MenuItem
            icon="schedule"
            onClick={() => choose("ping")}
            trailing={pingOn ? <span className="text-[11px] text-accent-text">On</span> : undefined}
          >
            Auto-ping…
          </MenuItem>
        )}
        {RESETTABLE.has(a.provider) && a.authType === "oauth" && (
          <MenuItem
            icon="restart_alt"
            onClick={() => {
              if (a.resetsLeft === 0) {
                setOpen(false);
                setNote({ text: "No resets left on this account" });
                setTimeout(() => setNote(null), 4000);
              } else choose("reset");
            }}
            trailing={
              a.resetsLeft != null ? (
                <span className="text-[11px] text-text-subtle">
                  {a.resetsLeft ? `${a.resetsLeft} left` : "none left"}
                </span>
              ) : undefined
            }
          >
            Reset limit…
          </MenuItem>
        )}
        <MenuItem
          icon={a.isActive ? "pause_circle" : "play_circle"}
          onClick={() => choose("routing")}
        >
          {a.isActive ? "Stop routing to it…" : "Start routing to it"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="open_in_new" href={`/dashboard/providers?p=${a.provider}`}>
          Open in Providers
        </MenuItem>
      </Popover>

      <ConfirmDialog
        open={dialog === "reset"}
        onClose={() => setDialog(null)}
        loading={busy}
        title={`Reset ${providerName(a.provider)} limits?`}
        message={
          a.provider === "claude"
            ? `This spends one of ${a.label}'s free limit resets${a.resetsLeft != null ? ` (${a.resetsLeft} left)` : ""} and refills its limits right away. It can't be undone.`
            : `This redeems one of ${a.label}'s Codex reset credits and refills its rate limit right away. It can't be undone.`
        }
        confirmText="Reset limits"
        onConfirm={() => run(() => actions.resetLimit(a), "Limits reset")}
      />
      <ConfirmDialog
        open={dialog === "routing"}
        onClose={() => setDialog(null)}
        loading={busy}
        variant={a.isActive ? "danger" : "primary"}
        title={a.isActive ? `Stop routing to ${a.label}?` : `Start routing to ${a.label}?`}
        message={
          a.isActive
            ? "Requests stop going to this account until you turn it back on. Its quota keeps being tracked."
            : "Requests can be sent to this account again."
        }
        confirmText={a.isActive ? "Stop routing" : "Start routing"}
        onConfirm={() =>
          run(() => actions.setActive([a.id], !a.isActive), a.isActive ? "Turned off" : "Turned on")
        }
      />
      {dialog === "ping" && ping && (
        <AutoPingScheduleModal
          isOpen
          onClose={() => setDialog(null)}
          connection={{ id: a.id, provider: a.provider, name: a.label }}
          reactive={ping.reactive}
          schedule={ping.schedule}
          onSave={(v) => void run(() => actions.saveAutoPing(a, v), "Auto-ping saved")}
        />
      )}
    </div>
  );
}
