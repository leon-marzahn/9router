// "Coming back": every upcoming reset on a 6h / 24h / 7d strip. A marker's
// color is how empty that limit is now; resets that land close together are
// stacked into one marker with a count (hover lists them, click opens the first).
"use client";

import { useMemo } from "react";
import { ProviderLogo, Segmented, Skeleton } from "@/ui";
import { cn } from "@/ui/cn";
import {
  barTone,
  pctText,
  providerName,
  untilText,
  windowLabel,
  type QuotaAccount,
  type QuotaWindow,
} from "./useQuota";

export type Span = 6 | 24 | 168;
const SPANS: { value: `${Span}`; label: string }[] = [
  { value: "6", label: "6h" },
  { value: "24", label: "24h" },
  { value: "168", label: "7d" },
];
/** Markers closer than this (fraction of the strip) are stacked. */
const CLUSTER = 0.025;

interface Event {
  a: QuotaAccount;
  w: QuotaWindow;
  t: number;
  x: number;
}

export function ResetTimeline({
  accounts,
  now,
  span,
  setSpan,
  highlight,
  onHover,
  onPick,
  title,
  loading = false,
}: {
  accounts: QuotaAccount[];
  now: number;
  span: Span;
  setSpan: (s: Span) => void;
  highlight?: string | null;
  onHover?: (id: string | null) => void;
  onPick?: (id: string) => void;
  title: string;
  loading?: boolean;
}) {
  const range = span * 3600_000;
  const events = useMemo<Event[]>(
    () =>
      accounts
        .filter((a) => a.isActive)
        .flatMap((a) =>
          a.windows
            .filter((w) => w.resetAt && w.remaining != null)
            .map((w) => {
              const t = new Date(w.resetAt!).getTime();
              return { a, w, t, x: (t - now) / range };
            }),
        )
        .filter((e) => e.x > 0 && e.x <= 1)
        .sort((p, q) => p.t - q.t),
    [accounts, now, range],
  );
  const clusters = useMemo(() => {
    const out: Event[][] = [];
    for (const e of events) {
      const last = out[out.length - 1];
      if (last && e.x - last[0].x < CLUSTER) last.push(e);
      else out.push([e]);
    }
    return out;
  }, [events]);

  const ticks =
    span === 6
      ? [0, 1, 2, 3, 4, 5, 6]
      : span === 24
        ? [0, 4, 8, 12, 16, 20, 24]
        : [0, 24, 48, 72, 96, 120, 144, 168];
  const tick = (h: number) => (h === 0 ? "now" : span === 168 ? `${h / 24}d` : `${h}h`);
  const rows = Math.min(3, Math.max(1, clusters.length));
  const pos = (x: number) => `calc(20px + (100% - 40px) * ${x})`;
  const spanText = span === 168 ? "week" : `${span} hours`;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl">{title}</h2>
          <p className="h-4 truncate text-xs leading-4 text-text-muted">
            {loading ? (
              <Skeleton className="inline-block h-3 w-64 align-middle" />
            ) : events.length ? (
              <>
                {events.length} reset{events.length === 1 ? "" : "s"} in the next {spanText} · next:{" "}
                <b className="text-text">{events[0].a.label}</b>{" "}
                {windowLabel(events[0].w.name).toLowerCase()} in{" "}
                {untilText(events[0].w.resetAt, now)}
              </>
            ) : (
              `Nothing resets in the next ${spanText}.`
            )}
          </p>
        </div>
        <Segmented<`${Span}`>
          value={`${span}` as `${Span}`}
          onChange={(v) => setSpan(Number(v) as Span)}
          options={SPANS}
          className="w-40"
        />
      </div>
      <div
        className="relative rounded-2xl border border-border bg-surface px-5 pb-3 pt-2 shadow-soft"
        style={{ height: 48 + rows * 26 }}
      >
        {ticks.map((h) => (
          <div
            key={h}
            className="absolute bottom-3 top-2 flex -translate-x-1/2 flex-col items-center"
            style={{ left: pos(h / span) }}
          >
            <span className="text-[10px] tabular-nums text-text-subtle">{tick(h)}</span>
            <span className="mt-1 w-px flex-1 bg-border/70" />
          </div>
        ))}
        {clusters.map((c, i) => {
          const first = c[0];
          const worst = c.reduce((m, e) => Math.min(m, e.w.remaining ?? 100), 100);
          const ids = new Set(c.map((e) => e.a.id));
          const label = c
            .map(
              (e) =>
                `${e.a.label} · ${windowLabel(e.w.name)} · ${pctText(e.w)} left · in ${untilText(e.w.resetAt, now)}`,
            )
            .join("\n");
          return (
            <button
              key={first.a.id + first.w.name}
              type="button"
              aria-label={label}
              title={label}
              onMouseEnter={() => onHover?.(c.length === 1 ? first.a.id : null)}
              onMouseLeave={() => onHover?.(null)}
              onClick={() => onPick?.(first.a.id)}
              className={cn(
                "absolute grid size-6 -translate-x-1/2 place-items-center rounded-full ring-2 ring-surface transition hover:scale-110",
                barTone(worst),
                highlight && !ids.has(highlight) && "opacity-25",
              )}
              style={{ left: pos(first.x), top: 30 + (i % rows) * 26 }}
            >
              <ProviderLogo
                providerId={first.a.provider}
                name={providerName(first.a.provider)}
                size={14}
              />
              {c.length > 1 && (
                <span className="absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-inverse px-1 text-[9px] font-semibold text-inverse-fg">
                  {c.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
