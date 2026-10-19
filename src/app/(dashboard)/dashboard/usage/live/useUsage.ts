// Data for the Usage page: period stats + chart from /api/usage/*, the logged
// request feed (summaries only; bodies are fetched per request), all kept live
// by the usage SSE stream.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Period = "today" | "24h" | "7d" | "30d" | "all";
export const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export interface ModelRow {
  key: string;
  label: string;
  provider?: string;
  requests: number;
  credits: number;
}

/** One API key (a customer): what its requests cost upstream vs what it was charged. */
export interface KeyRow {
  key: string;
  name: string;
  requests: number;
  cost: number;
  charge: number;
}

export interface Active {
  model: string;
  provider: string;
  account?: string;
  count: number;
}

export interface ChartPoint {
  label: string;
  requests: number;
  tokens: number;
  cost: number;
  credits: number;
}

/** One logged request (no bodies; fetch /api/usage/request-details/:id for those). */
export interface FeedItem {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  status: string;
  inTokens: number;
  outTokens: number;
  cachedTokens: number;
  credits: number;
  cost: number;
  ttft?: number;
  total?: number;
  pxpipeSavedPct?: number;
  /** Routing trace id (attempts, fallbacks) for the request inspector. */
  traceId?: string;
  /** False for the stats fallback list (request logging off): no bodies; only the route trace. */
  logged: boolean;
}

export interface Totals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  credits: number;
}

export interface Usage {
  totals: Totals;
  byModel: ModelRow[];
  byKey: KeyRow[];
  active: Active[];
  chart: ChartPoint[];
  /** Requests per minute over the last 10 minutes (oldest first). */
  perMinute: number[];
  /** Newest logged requests, or the stats' recent list when logging is off. */
  feed: FeedItem[];
  logging: boolean;
}

type Raw = Record<string, any>;

const FEED_PAGE = 60;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const isFailed = (status: string) =>
  !!status && !["ok", "success", "200", "completed"].includes(String(status).toLowerCase());

export function feedItemOf(d: Raw): FeedItem {
  const t = d.tokens ?? {};
  const cached = num(t.cached_tokens) || num(t.cache_read_input_tokens);
  const prompt = num(t.prompt_tokens) || num(t.input_tokens);
  return {
    id: String(d.id),
    timestamp: d.timestamp,
    model: d.model ?? "unknown",
    provider: d.provider ?? "",
    status: d.status ?? "",
    // Legacy rows may store prompt cache-exclusive; never report less than the cache.
    inTokens: Math.max(prompt, cached),
    outTokens: num(t.completion_tokens) || num(t.output_tokens),
    cachedTokens: cached,
    credits: num(t.credits),
    cost: num(d.cost),
    ttft: d.latency?.ttft,
    total: d.latency?.total,
    pxpipeSavedPct: d.pxpipe?.applied ? d.pxpipe.savedPct : undefined,
    traceId: typeof d.traceId === "string" ? d.traceId : undefined,
    logged: true,
  };
}

const recentItemOf = (r: Raw, i: number): FeedItem => ({
  id: `recent-${r.timestamp}-${i}`,
  timestamp: r.timestamp,
  model: r.model ?? "unknown",
  provider: r.provider ?? "",
  status: r.status ?? "",
  inTokens: num(r.promptTokens),
  outTokens: num(r.completionTokens),
  cachedTokens: num(r.cachedTokens),
  credits: 0,
  cost: 0,
  traceId: typeof r.traceId === "string" ? r.traceId : undefined,
  logged: false,
});

/** byApiKey buckets are per key + model: fold them per key. Local (no key) is left out. */
export function keyRows(byApiKey: Raw): KeyRow[] {
  const out = new Map<string, KeyRow>();
  for (const [k, v] of Object.entries(byApiKey)) {
    if (k === "local-no-key") continue;
    const id = String(v.keyId ?? v.keyName ?? k);
    const row = out.get(id) ?? { key: id, name: v.keyName ?? id, requests: 0, cost: 0, charge: 0 };
    row.requests += num(v.requests);
    row.cost += num(v.cost);
    row.charge += typeof v.charge === "number" ? v.charge : num(v.cost);
    out.set(id, row);
  }
  return [...out.values()].sort((a, b) => b.charge - a.charge || b.requests - a.requests);
}

function statsPart(s: Raw) {
  return {
    totals: {
      requests: num(s.totalRequests),
      promptTokens: num(s.totalPromptTokens),
      completionTokens: num(s.totalCompletionTokens),
      cachedTokens: num(s.totalCachedTokens),
      cost: num(s.totalCost),
      credits: num(s.totalCredits),
    },
    byModel: Object.entries((s.byModel ?? {}) as Raw)
      .map(([k, v]) => ({
        key: k,
        label: v.rawModel ?? k,
        provider: v.provider,
        requests: num(v.requests),
        credits: num(v.credits),
      }))
      .sort((a, b) => b.requests - a.requests),
    byKey: keyRows(s.byApiKey ?? {}),
    active: (s.activeRequests ?? []) as Active[],
    perMinute: ((s.last10Minutes ?? []) as Raw[]).map((b) => num(b.requests)),
  };
}

const getJson = (url: string): Promise<Raw> =>
  fetch(url).then((r) => (r.ok ? r.json() : Promise.resolve({})));

export function useUsage(period: Period) {
  const [data, setData] = useState<Usage | null>(null);
  const [older, setOlder] = useState<FeedItem[]>([]);
  const [olderPage, setOlderPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const recent = useRef<Raw[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (): Promise<void> => {
    let s: Raw, c: unknown, d: Raw;
    try {
      [s, c, d] = await Promise.all([
        getJson(`/api/usage/stats?period=${period}`),
        fetch(`/api/usage/chart?period=${period}`).then((r) => (r.ok ? r.json() : [])),
        getJson(`/api/usage/request-details?page=1&pageSize=${FEED_PAGE}&summary=1`),
      ]);
    } catch {
      return; // Server unreachable; keep showing the last data until the next update.
    }
    recent.current = s.recentRequests ?? [];
    const logged: FeedItem[] = (d.details ?? []).map(feedItemOf);
    setHasMore(!!d.pagination?.hasNext);
    setData({
      ...statsPart(s),
      chart: (Array.isArray(c) ? c : []).map((p: Raw) => ({
        label: p.label,
        requests: num(p.requests),
        tokens: num(p.tokens),
        cost: num(p.cost),
        credits: num(p.credits),
      })),
      feed: logged.length ? logged : recent.current.map(recentItemOf),
      logging: logged.length > 0,
    });
  }, [period]);

  // Initial load, then live: the stream pushes in-flight requests immediately;
  // everything else refetches at most once a second while traffic flows.
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const es = new EventSource("/api/usage/stream");
    es.onmessage = (e) => {
      try {
        const s = JSON.parse(e.data);
        setData((prev) => (prev ? { ...prev, active: s.activeRequests ?? [] } : prev));
        if (!timer.current)
          timer.current = setTimeout(() => {
            timer.current = null;
            void load();
          }, 1000);
      } catch {
        // Ignore malformed frames; the next one replaces them.
      }
    };
    return () => {
      es.close();
      clearTimeout(first);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);

  /** Fetch the next page of older logged requests (user-initiated, appended at the bottom). */
  const loadOlder = useCallback(async () => {
    const page = olderPage + 1;
    const d = await getJson(
      `/api/usage/request-details?page=${page}&pageSize=${FEED_PAGE}&summary=1`,
    );
    setOlder((o) => [...o, ...((d.details ?? []) as Raw[]).map(feedItemOf)]);
    setOlderPage(page);
    setHasMore(!!d.pagination?.hasNext);
  }, [olderPage]);

  const merged = useMemo(() => {
    if (!data) return null;
    if (!older.length) return data;
    const seen = new Set(data.feed.map((r) => r.id));
    return { ...data, feed: [...data.feed, ...older.filter((r) => !seen.has(r.id))] };
  }, [data, older]);

  return { data: merged, loadOlder, hasMore: hasMore && !!data?.logging };
}

// ---------- formatting ----------

export function fmtTokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtCost(n: number) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function timeAgo(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Re-render every second for relative times. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const cacheRate = (t: Totals) =>
  t.promptTokens ? Math.round((t.cachedTokens / t.promptTokens) * 100) : 0;
