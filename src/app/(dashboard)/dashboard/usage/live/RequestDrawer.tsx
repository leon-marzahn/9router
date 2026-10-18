// Side drawer with one logged request: its numbers and the four captured
// payloads. Bodies are fetched when opened — never part of the live feed.
"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Icon, IconButton, Kbd, StatusLabel, Tag } from "@/ui";
import { cn } from "@/ui/cn";
import { fmtCost, fmtTokens, isFailed, type FeedItem } from "./useUsage";

type Raw = Record<string, any>;

const SECTIONS: { key: string; title: string; hint: string }[] = [
  { key: "request", title: "Client request", hint: "what your tool sent" },
  { key: "providerRequest", title: "Provider request", hint: "after translation" },
  { key: "providerResponse", title: "Provider response", hint: "raw, from upstream" },
  { key: "response", title: "Client response", hint: "what your tool received" },
];

export function RequestDrawer({
  item,
  onClose,
  onStep,
  position,
}: {
  item: FeedItem;
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
  position: string;
}) {
  const [detail, setDetail] = useState<Raw | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/usage/request-details/${encodeURIComponent(item.id)}`)
      .then((r) =>
        r.ok
          ? r.json()
          : Promise.reject(
              new Error(
                r.status === 404
                  ? "This request is no longer stored."
                  : "Couldn't load the request.",
              ),
            ),
      )
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        onStep(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  const failed = isFailed(item.status);
  const stats: [string, string][] = [
    ["Input", fmtTokens(item.inTokens)],
    ["Cached", item.cachedTokens ? fmtTokens(item.cachedTokens) : "—"],
    ["Output", fmtTokens(item.outTokens)],
    ["Credits", item.credits ? item.credits.toFixed(2) : "—"],
    ["Cost", item.cost ? fmtCost(item.cost) : "—"],
    ["First token", item.ttft != null ? `${(item.ttft / 1000).toFixed(2)}s` : "—"],
    ["Total", item.total != null ? `${(item.total / 1000).toFixed(1)}s` : "—"],
    ["Token saver", item.pxpipeSavedPct != null ? `−${item.pxpipeSavedPct}%` : "off"],
  ];

  return (
    <aside
      role="dialog"
      aria-label="Request details"
      className="fixed bottom-0 right-0 top-12 z-40 flex w-[min(560px,100vw)] flex-col border-l border-border bg-surface shadow-elev"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm">{item.model}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
            <StatusLabel status={failed ? "error" : "ok"} label={failed ? "Failed" : "Completed"} />
            <span>·</span>
            <span>{item.provider}</span>
            <span>·</span>
            <span className="tabular-nums">{new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
        </div>
        <span className="mt-0.5 text-[11px] tabular-nums text-text-subtle">{position}</span>
        <IconButton icon="keyboard_arrow_up" label="Previous (k)" onClick={() => onStep(-1)} />
        <IconButton icon="keyboard_arrow_down" label="Next (j)" onClick={() => onStep(1)} />
        <IconButton icon="close" label="Close (Esc)" onClick={onClose} />
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-border bg-border">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-surface px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-text-subtle">{k}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>

        {failed && detail?.providerResponse?.error && (
          <div className="rounded-xl border border-danger-border bg-danger-soft px-4 py-3 text-xs text-danger-text">
            <Tag tone="danger" mono className="mr-2">
              {detail.providerResponse.error.type ?? "ERR"}
            </Tag>
            {detail.providerResponse.error.message}
          </div>
        )}

        {error ? (
          <p className="text-sm text-text-muted">{error}</p>
        ) : !detail ? (
          <p className="text-sm text-text-muted">Loading request…</p>
        ) : (
          <div className="space-y-2">
            {detail.response?.thinking && <Thinking text={detail.response.thinking} />}
            {SECTIONS.map((s, i) => (
              <Section
                key={s.key}
                title={s.title}
                hint={s.hint}
                value={detail[s.key]}
                defaultOpen={i === 0 || i === 3}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-3 border-t border-border px-5 py-2.5 text-[11px] text-text-subtle">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> step
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
        <span className="ml-auto">Live feed paused while open</span>
      </footer>
    </aside>
  );
}

function Section({
  title,
  hint,
  value,
  defaultOpen,
}: {
  title: string;
  hint: string;
  value: unknown;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const empty =
    value == null || (typeof value === "object" && Object.keys(value as object).length === 0);
  const text = empty ? "" : JSON.stringify(value, null, 2);
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2"
      >
        <Icon
          name={open ? "expand_more" : "chevron_right"}
          size={18}
          className="text-text-subtle"
        />
        <span className="text-[13px] font-medium">{title}</span>
        <span className="text-[11px] text-text-subtle">{hint}</span>
        {!empty && (
          <span className="ml-auto text-[11px] tabular-nums text-text-subtle">
            {fmtTokens(text.length)} chars
          </span>
        )}
      </button>
      {open && (
        <pre
          className={cn(
            "max-h-80 overflow-auto border-t border-border bg-bg-alt px-4 py-3 font-mono text-[11px] leading-relaxed",
            empty && "text-text-subtle",
          )}
        >
          {empty ? "Not captured." : text}
        </pre>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-alt px-4 py-3">
      <Eyebrow className="mb-1">Thinking</Eyebrow>
      <p className="whitespace-pre-wrap text-xs text-text-muted">{text}</p>
    </div>
  );
}
