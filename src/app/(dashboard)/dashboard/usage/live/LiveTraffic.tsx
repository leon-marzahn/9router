// Usage page ("live traffic"): the requests themselves are the page. The feed
// freezes while you inspect it (hover, Pause, or an open request) and queues
// new requests behind an "N new" bar, so rows never move under the cursor.
// Period totals, trend and top models sit in the side column.
"use client";

import Link from "next/link";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  Eyebrow,
  Kbd,
  Panel,
  Segmented,
  StatGrid,
  StatusDot,
  Tag,
  TopBarContent,
  useFlashOnChange,
} from "@/ui";
import { cn } from "@/ui/cn";
import { AreaChart, ShareBar, Spark, type Metric } from "./shared";
import { RequestDrawer } from "./RequestDrawer";
import {
  PERIODS,
  cacheRate,
  fmtCost,
  fmtTokens,
  isFailed,
  timeAgo,
  useNow,
  useUsage,
  type FeedItem,
  type Period,
  type Usage,
} from "./useUsage";

export function LiveTraffic() {
  const [period, setPeriod] = useState<Period>("today");
  const { data, loadOlder, hasMore } = useUsage(period);
  if (!data) return <p className="text-sm text-text-muted">Loading usage…</p>;
  return (
    <Feed u={data} period={period} setPeriod={setPeriod} loadOlder={loadOlder} hasMore={hasMore} />
  );
}

function Feed({
  u,
  period,
  setPeriod,
  loadOlder,
  hasMore,
}: {
  u: Usage;
  period: Period;
  setPeriod: (p: Period) => void;
  loadOlder: () => Promise<void>;
  hasMore: boolean;
}) {
  const now = useNow();
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [metric, setMetric] = useState<Metric>("requests");
  const [manualPause, setManualPause] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<FeedItem[] | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logged = u.logging;
  const live = u.feed;

  const paused = manualPause || hovering || selectedId != null;
  // Snapshot the list the moment something pauses it; while paused, render the snapshot.
  const freeze = () => {
    if (!paused) setFrozen(live);
  };

  const base = paused && frozen ? frozen : live;
  const shown = filter === "errors" ? base.filter((r) => isFailed(r.status)) : base;
  const frozenIds = useMemo(() => new Set((frozen ?? []).map((r) => r.id)), [frozen]);
  const newCount = paused && frozen ? live.filter((r) => !frozenIds.has(r.id)).length : 0;
  const selectedIndex = shown.findIndex((r) => r.id === selectedId);
  const selected = selectedIndex >= 0 ? shown[selectedIndex] : null;

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!shown.length) return;
      const i = Math.min(
        shown.length - 1,
        Math.max(0, (selectedIndex < 0 ? -1 : selectedIndex) + dir),
      );
      setSelectedId(shown[i].id);
      document.querySelector(`[data-req="${shown[i].id}"]`)?.scrollIntoView({ block: "nearest" });
    },
    [shown, selectedIndex],
  );

  const resume = () => {
    setManualPause(false);
    setHovering(false);
    setSelectedId(null);
    setFrozen(null);
  };

  const inFlight = u.active.reduce((a, x) => a + x.count, 0);
  const rpm = u.perMinute.length ? u.perMinute[u.perMinute.length - 1] : 0;
  const latency = useMemo(() => {
    const med = (xs: number[]) => {
      if (!xs.length) return null;
      const a = [...xs].sort((x, y) => x - y);
      return a[Math.floor(a.length / 2)];
    };
    const ok = live.filter((r) => !isFailed(r.status));
    const ttft = med(ok.map((r) => r.ttft).filter((v): v is number => v != null));
    const total = med(ok.map((r) => r.total).filter((v): v is number => v != null));
    const errors = live.filter((r) => isFailed(r.status)).length;
    const sec = (ms: number | null, d: number) => (ms == null ? "—" : `${(ms / 1000).toFixed(d)}s`);
    return {
      ttft: sec(ttft, 2),
      total: sec(total, 1),
      errors,
      errorPct: live.length ? `${Math.round((errors / live.length) * 100)}%` : "—",
    };
  }, [live]);
  const feedRef = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState(0);
  const drawerOpen = !!selected;
  useLayoutEffect(() => {
    const measure = () => {
      const el = feedRef.current;
      if (!drawerOpen || !el || window.innerWidth < 1024) return setOverlap(0);
      const drawerLeft = window.innerWidth - Math.min(560, window.innerWidth);
      const contentRight = el.getBoundingClientRect().right; // padding-box, independent of paddingRight
      setOverlap(Math.max(0, Math.ceil(contentRight - drawerLeft + 16)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [drawerOpen]);
  const hasCredits = u.totals.credits > 0 || u.chart.some((p) => p.credits > 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <TopBarContent>
        <span className="flex items-center gap-2 text-xs text-text-muted">
          <StatusDot status={inFlight ? "ok" : "none"} live={inFlight > 0} />
          <b className="w-3 tabular-nums text-text">{inFlight}</b> in flight
          <span className="text-text-subtle">·</span>
          <b className="tabular-nums text-text">{rpm}</b> req/min
          <span className="text-text-subtle">·</span>
          <span title="Median time to first token over the live window">
            TTFT <b className="tabular-nums text-text">{latency.ttft}</b>
          </span>
          <span className="text-text-subtle">·</span>
          <span title="Median total request time over the live window">
            total <b className="tabular-nums text-text">{latency.total}</b>
          </span>
          <span className="text-text-subtle">·</span>
          <span
            title="Failed requests in the live window"
            className={latency.errors > 0 ? "text-danger-text" : undefined}
          >
            <b
              className={cn("tabular-nums", latency.errors > 0 ? "text-danger-text" : "text-text")}
            >
              {latency.errorPct}
            </b>{" "}
            errors
          </span>
        </span>
      </TopBarContent>

      {/* While a request is open the drawer covers the stats column; the feed only
          gives up the width the drawer actually overlaps (often none). */}
      <div ref={feedRef} className="min-w-0 space-y-4" style={{ paddingRight: overlap }}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight">Live traffic</h1>
            <p className="mt-1 text-sm text-text-muted">
              Every request through the gateway. Click one to inspect it.
            </p>
          </div>
          <Segmented<"all" | "errors">
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "errors", label: "Errors" },
            ]}
            className="w-full md:w-40"
          />
        </div>

        {/* Fixed slots: in-flight requests come and go without resizing anything. */}
        <InFlight active={u.active} />

        <Panel
          className="overflow-hidden"
          // Only a real mouse holds the list; touch "hover" is an emulated tap side effect.
          onPointerEnter={(e) => {
            if (e.pointerType !== "mouse") return;
            if (leaveTimer.current) clearTimeout(leaveTimer.current);
            freeze();
            setHovering(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            leaveTimer.current = setTimeout(() => setHovering(false), 500);
          }}
        >
          {/* Status bar: always the same height, so pausing never shifts rows. */}
          <div
            className={cn(
              "flex h-10 items-center gap-3 border-b border-border px-4 text-xs",
              paused ? "bg-surface-2" : "bg-surface",
            )}
          >
            {paused ? (
              <>
                <span className="material-symbols-outlined text-[16px] text-text-muted">pause</span>
                <span className="min-w-0 truncate text-text-muted">
                  Paused
                  {selectedId
                    ? " while a request is open"
                    : hovering && !manualPause
                      ? " while you look"
                      : ""}
                </span>
                {newCount > 0 && (
                  <Tag tone="accent" className="tabular-nums">
                    {newCount} new
                  </Tag>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon="play_arrow"
                  onClick={resume}
                >
                  {newCount > 0 ? "Show new" : "Resume"}
                </Button>
              </>
            ) : (
              <>
                <StatusDot status="ok" live />
                <span className="text-text-muted">Live</span>
                <span className="hidden min-w-0 truncate text-text-subtle [@media(hover:hover)]:inline">
                  · hover the list to hold it still
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon="pause"
                  onClick={() => {
                    freeze();
                    setManualPause(true);
                  }}
                >
                  Pause
                </Button>
              </>
            )}
          </div>

          {/* Below md rows stack; from md up the table scrolls sideways rather than squeezing columns. */}
          <div className="md:overflow-x-auto md:overscroll-x-contain">
            <div className="md:min-w-[640px]">
              <div className="hidden grid-cols-[6px_minmax(0,1fr)_6.5rem_4rem_5rem_3.5rem_4rem] gap-3 border-b border-border px-4 py-2 text-[11px] uppercase md:grid tracking-wider text-text-muted">
                <span />
                <span>Model</span>
                <span className="text-right">In → out</span>
                <span className="text-right">Cached</span>
                <span className="text-right">{hasCredits ? "Cost / cr" : "Cost"}</span>
                <span className="text-right">Time</span>
                <span className="text-right">When</span>
              </div>

              {shown.length ? (
                shown.map((r) => (
                  <FeedRow
                    key={r.id}
                    r={r}
                    now={now}
                    active={r.id === selectedId}
                    onClick={
                      r.logged || r.traceId
                        ? () => {
                            freeze();
                            setSelectedId(r.id === selectedId ? null : r.id);
                          }
                        : undefined
                    }
                  />
                ))
              ) : filter === "errors" ? (
                <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
                  No failed requests in this window.
                </p>
              ) : (
                <EmptyState icon="sensors" className="m-4">
                  Waiting for traffic…
                </EmptyState>
              )}
            </div>
          </div>

          {logged && hasMore && <LoadOlder onLoad={loadOlder} />}

          {!logged && live.length > 0 && (
            <p className="border-t border-border px-4 py-3 text-xs text-text-muted">
              Turn on request logging in{" "}
              <Link
                href="/dashboard/profile"
                className="text-accent-text underline underline-offset-2"
              >
                Settings
              </Link>{" "}
              to capture request bodies and see credits, cost and latency per request.
            </p>
          )}
        </Panel>
      </div>

      <aside
        className={cn("space-y-4 lg:sticky lg:top-0 lg:self-start", selected && "lg:invisible")}
      >
        <Segmented<Period> value={period} onChange={setPeriod} options={PERIODS} />
        <StatGrid
          className="sm:grid-cols-2"
          items={[
            { label: "Requests", value: u.totals.requests },
            {
              label: "Est. cost",
              value: fmtCost(u.totals.cost),
              sub: u.totals.requests
                ? `${fmtCost(u.totals.cost / u.totals.requests)} / req`
                : undefined,
            },
            { label: "Input", value: fmtTokens(u.totals.promptTokens), sub: "tokens" },
            {
              label: "Cached",
              value: fmtTokens(u.totals.cachedTokens),
              sub: `${cacheRate(u.totals)}% of input`,
            },
            { label: "Output", value: fmtTokens(u.totals.completionTokens), sub: "tokens" },
            {
              label: "Credits",
              value: u.totals.credits ? u.totals.credits.toFixed(1) : "—",
              sub: u.totals.credits ? "credit-billed" : "none used",
            },
          ]}
        />
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>Requests / min</Eyebrow>
            <span className="text-[11px] text-text-subtle">last 10 min</span>
          </div>
          <Spark values={u.perMinute.length ? u.perMinute : [0]} className="h-14" />
        </Panel>
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Eyebrow>Trend</Eyebrow>
            <Segmented<Metric>
              value={metric}
              onChange={setMetric}
              options={[
                { value: "requests", label: "Req" },
                { value: "tokens", label: "Tok" },
                { value: "cost", label: "$" },
                ...(hasCredits ? [{ value: "credits" as const, label: "Cr" }] : []),
              ]}
              className={hasCredits ? "w-44 max-md:w-52" : "w-36 max-md:w-44"}
            />
          </div>
          <AreaChart points={u.chart} metric={metric as Metric} height={90} />
        </Panel>
        <Panel className="p-4">
          <Eyebrow className="mb-3">Top models</Eyebrow>
          <div className="space-y-2.5">
            {topModels(u.byModel).map((m) => (
              <div key={m.key} className="space-y-1">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="truncate font-mono">{m.label}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">
                    {m.credits ? `${m.credits.toFixed(1)} cr · ` : ""}
                    {Math.round(m.share * 100)}%
                  </span>
                </div>
                <ShareBar share={m.share} />
              </div>
            ))}
          </div>
        </Panel>
        {u.byKey.length > 0 && <ByKey rows={u.byKey} />}
        <p className="flex items-center gap-1.5 text-[11px] text-text-subtle">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> step through requests once one is open
        </p>
      </aside>

      {selected && (
        <RequestDrawer
          key={selected.id}
          item={selected}
          onClose={() => setSelectedId(null)}
          onStep={step}
          position={`${selectedIndex + 1} / ${shown.length}`}
        />
      )}
    </div>
  );
}

const SLOTS = 3;

function InFlight({ active }: { active: Usage["active"] }) {
  const [expanded, setExpanded] = useState(false);
  const extra = active.length - SLOTS;
  const rows = expanded ? active : active.slice(0, SLOTS);
  const slots = Math.max(SLOTS, rows.length);
  return (
    <Panel className="overflow-hidden border-accent-ring">
      <div className="flex h-8 items-center gap-2 bg-accent-soft px-4 text-[11px] font-medium uppercase tracking-wider text-accent-text">
        <StatusDot status={active.length ? "ok" : "none"} live={active.length > 0} /> In flight
        <span className="tabular-nums normal-case tracking-normal opacity-70">{active.length}</span>
        {(extra > 0 || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="ml-auto normal-case tracking-normal hover:underline"
          >
            {expanded ? "Show less" : `+${extra} more`}
          </button>
        )}
      </div>
      {Array.from({ length: slots }, (_, i) => {
        const a = rows[i];
        return (
          <div key={i} className="flex h-9 items-center gap-3 border-t border-border px-4 text-xs">
            {a ? (
              <>
                <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
                <span className="truncate font-mono">{a.model}</span>
                <span className="truncate text-text-muted">
                  {a.providerName || a.provider}
                  {a.account ? ` · ${a.account}` : ""}
                </span>
                <Tag tone="accent" className="ml-auto shrink-0">
                  streaming
                </Tag>
              </>
            ) : (
              i === 0 && <span className="text-text-subtle">Nothing streaming right now.</span>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function FeedRow({
  r,
  now,
  active,
  onClick,
}: {
  r: FeedItem;
  now: number;
  active: boolean;
  onClick?: () => void;
}) {
  const flash = useFlashOnChange(r.id);
  const failed = isFailed(r.status);
  return (
    <button
      type="button"
      data-req={r.id}
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "block w-full border-b border-border px-4 text-left text-[13px] last:border-0",
        onClick && "hover:bg-surface-2/70",
        active && "bg-accent-soft ring-1 ring-inset ring-accent-ring",
        flash && !active && "animate-live-flash",
      )}
    >
      <MobileFeedRow r={r} now={now} failed={failed} />
      <span className="hidden h-12 grid-cols-[6px_minmax(0,1fr)_6.5rem_4rem_5rem_3.5rem_4rem] items-center gap-3 md:grid">
        <StatusDot status={failed ? "error" : "ok"} />
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs">{r.model}</span>
          <span className="block truncate text-[11px] text-text-muted">{r.providerName || r.provider}</span>
        </span>
        <span className="text-right text-xs tabular-nums text-text-muted">
          {fmtTokens(r.inTokens)} <span className="text-text-subtle">→</span>{" "}
          {fmtTokens(r.outTokens)}
        </span>
        <span className="text-right text-xs tabular-nums text-text-muted">
          {r.cachedTokens ? fmtTokens(r.cachedTokens) : <span className="text-text-subtle">—</span>}
        </span>
        <span className="text-right text-xs tabular-nums">
          {failed ? (
            <Tag tone="danger" mono>
              ERR
            </Tag>
          ) : r.credits ? (
            <span>{r.credits.toFixed(2)} cr</span>
          ) : r.cost ? (
            fmtCost(r.cost)
          ) : (
            <span className="text-text-subtle">—</span>
          )}
        </span>
        <span className="text-right text-xs tabular-nums text-text-muted">
          {r.total != null ? `${(r.total / 1000).toFixed(1)}s` : "—"}
        </span>
        <span className="text-right text-[11px] tabular-nums text-text-subtle">
          {timeAgo(r.timestamp, now)}
        </span>
      </span>
    </button>
  );
}

function MobileFeedRow({ r, now, failed }: { r: FeedItem; now: number; failed: boolean }) {
  const sub = "text-[11px] tabular-nums text-text-muted";
  return (
    <span className="flex items-start gap-3 py-2.5 md:hidden">
      <StatusDot status={failed ? "error" : "ok"} className="mt-1.5 shrink-0" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.model}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-text-subtle">
            {timeAgo(r.timestamp, now)}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{r.providerName || r.provider}</span>
          <span className="shrink-0 text-xs tabular-nums">
            {failed ? (
              <Tag tone="danger" mono>
                ERR
              </Tag>
            ) : r.credits ? (
              `${r.credits.toFixed(2)} cr`
            ) : r.cost ? (
              fmtCost(r.cost)
            ) : (
              <span className="text-text-subtle">—</span>
            )}
          </span>
        </span>
        <span className={cn("flex flex-wrap gap-x-3", sub)}>
          <span>
            {fmtTokens(r.inTokens)} <span className="text-text-subtle">→</span>{" "}
            {fmtTokens(r.outTokens)}
          </span>
          {r.cachedTokens ? <span>{fmtTokens(r.cachedTokens)} cached</span> : null}
          <span>{r.total != null ? `${(r.total / 1000).toFixed(1)}s` : "—"}</span>
        </span>
      </span>
    </span>
  );
}

const signedCost = (n: number) => (n < 0 ? `−${fmtCost(-n)}` : fmtCost(n));

/** Per customer key: charged, upstream cost, and the margin between them. */
export function ByKey({ rows }: { rows: Usage["byKey"] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 5);
  const total = rows.reduce((t, r) => ({ cost: t.cost + r.cost, charge: t.charge + r.charge }), {
    cost: 0,
    charge: 0,
  });
  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Eyebrow>By key</Eyebrow>
        <span className="text-[11px] tabular-nums text-text-subtle">
          margin {signedCost(total.charge - total.cost)}
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-3 gap-y-2 text-xs">
        <span className="text-[11px] text-text-subtle">Key</span>
        <span className="text-right text-[11px] text-text-subtle">Charged</span>
        <span className="text-right text-[11px] text-text-subtle">Cost</span>
        <span className="text-right text-[11px] text-text-subtle">Margin</span>
        {shown.map((r) => {
          const margin = r.charge - r.cost;
          return (
            <div key={r.key} className="contents">
              <span className="truncate" title={`${r.requests.toLocaleString()} requests`}>
                {r.name}
              </span>
              <span className="text-right tabular-nums">{fmtCost(r.charge)}</span>
              <span className="text-right tabular-nums text-text-muted">{fmtCost(r.cost)}</span>
              <span
                className={cn(
                  "text-right tabular-nums",
                  margin < 0 ? "text-danger-text" : "text-text-muted",
                )}
              >
                {signedCost(margin)}
              </span>
            </div>
          );
        })}
      </div>
      {rows.length > 5 && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setAll(!all)}>
          {all ? "Show less" : `All ${rows.length} keys`}
        </Button>
      )}
    </Panel>
  );
}

function topModels(rows: Usage["byModel"]) {
  const total = rows.reduce((a, r) => a + r.requests, 0) || 1;
  return rows.slice(0, 5).map((r) => ({ ...r, share: r.requests / total }));
}

function LoadOlder({ onLoad }: { onLoad: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="border-t border-border px-4 py-2 text-center">
      <Button
        size="sm"
        variant="ghost"
        icon="expand_more"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onLoad();
          } finally {
            setBusy(false);
          }
        }}
      >
        Load older requests
      </Button>
    </div>
  );
}
