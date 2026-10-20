// Side drawer with one logged request: its numbers and the four captured
// payloads. Bodies are fetched when opened — never part of the live feed.
"use client";

import { useEffect, useState } from "react";
import { CodeBlock, Eyebrow, Icon, IconButton, Kbd, StatGrid, StatusLabel, Tag } from "@/ui";
import { RouteTrace } from "./RouteTrace";
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
    // Bodies exist only when request logging is on; unlogged rows show the route alone.
    if (!item.logged) return;
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
  }, [item.id, item.logged]);

  // On phones the drawer is full-screen: lock the page behind it so only the
  // drawer scrolls (otherwise both scroll areas fight over the same swipe).
  useEffect(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    const page = document.querySelector("main");
    const body = document.body;
    const prev = [page?.style.overflow ?? "", body.style.overflow];
    if (page) page.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      if (page) page.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
  }, []);

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
  const stats = [
    { label: "Input", value: fmtTokens(item.inTokens) },
    { label: "Cached", value: item.cachedTokens ? fmtTokens(item.cachedTokens) : "—" },
    { label: "Output", value: fmtTokens(item.outTokens) },
    { label: "Credits", value: item.credits ? item.credits.toFixed(2) : "—" },
    { label: "Cost", value: item.cost ? fmtCost(item.cost) : "—" },
    { label: "First token", value: item.ttft != null ? `${(item.ttft / 1000).toFixed(2)}s` : "—" },
    { label: "Total", value: item.total != null ? `${(item.total / 1000).toFixed(1)}s` : "—" },
    {
      label: "Token saver",
      value: item.pxpipeSavedPct != null ? `−${item.pxpipeSavedPct}%` : "off",
    },
  ];

  return (
    <aside
      role="dialog"
      aria-label="Request details"
      className="fixed inset-0 z-50 flex flex-col bg-surface md:inset-auto md:bottom-0 md:right-0 md:top-12 md:z-40 md:w-[min(560px,100vw)] md:border-l md:border-border md:shadow-elev"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm">{item.model}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-nowrap text-xs text-text-muted">
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

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5">
        <StatGrid items={stats} compactOnMobile />

        <RouteTrace key={item.traceId ?? item.id} traceId={item.traceId} />

        {failed && detail?.providerResponse?.error && (
          <div className="rounded-xl border border-danger-border bg-danger-soft px-4 py-3 text-xs text-danger-text">
            <Tag tone="danger" mono className="mr-2">
              {detail.providerResponse.error.type ?? "ERR"}
            </Tag>
            {detail.providerResponse.error.message}
          </div>
        )}

        {!item.logged ? (
          <p className="text-[12px] text-text-muted">
            Request and response bodies aren&apos;t captured while request logging is off.
          </p>
        ) : error ? (
          <p className="text-sm text-text-muted">{error}</p>
        ) : !detail ? (
          <p className="text-sm text-text-muted">Loading request…</p>
        ) : (
          <div className="space-y-2">
            {detail.response?.thinking && <Thinking text={detail.response.thinking} />}
            <RegentHeaders headers={detail.request?.regentHeaders} />
            {SECTIONS.map((s, i) => (
              <Section
                key={s.key}
                title={s.title}
                hint={s.hint}
                value={s.key === "request" ? withoutRegentHeaders(detail.request) : detail[s.key]}
                defaultOpen={i === 0 || i === 3}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="hidden items-center gap-3 border-t border-border px-5 py-2.5 text-[11px] text-text-subtle md:flex">
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
    <CodeBlock
      title={
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left max-md:min-h-10"
        >
          <Icon
            name={open ? "expand_more" : "chevron_right"}
            size={18}
            className="text-text-subtle"
          />
          <span className="text-[13px]">{title}</span>
          <span className="hidden text-[11px] font-normal text-text-subtle sm:inline">{hint}</span>
        </button>
      }
      meta={
        !empty && (
          <span className="ml-auto text-[11px] font-normal tabular-nums text-text-subtle">
            {fmtTokens(text.length)} chars
          </span>
        )
      }
      copy={empty ? undefined : text}
      text={open ? (empty ? "Not captured." : text) : undefined}
      muted={empty}
      label={title}
      preClassName="max-h-80 text-[11px]"
      className="rounded-xl"
    />
  );
}

// Shown in their own block above, so keep them out of the raw request JSON.
function withoutRegentHeaders(request: Raw | undefined) {
  if (!request) return request;
  const { regentHeaders: _omit, ...rest } = request;
  return rest;
}

function RegentHeaders({ headers }: { headers?: Record<string, string> }) {
  const entries = headers ? Object.entries(headers) : [];
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="px-4 py-2.5 text-[13px] font-medium">
        Regent headers
        <span className="ml-2 hidden text-[11px] font-normal text-text-subtle sm:inline">
          control headers your tool sent
        </span>
      </div>
      <dl className="border-t border-border bg-bg-alt px-4 py-3 font-mono text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <dd className="text-text-subtle">None sent.</dd>
        ) : (
          entries.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="shrink-0 text-text-muted">{k}</dt>
              <dd className="min-w-0 break-all">{v}</dd>
            </div>
          ))
        )}
      </dl>
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
