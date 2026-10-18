// Data and actions for the Quota page: quota-capable accounts from
// /api/providers/client, each account's limits from /api/usage/:id (normalized
// by parseQuotaData), plus the per-provider settings that shape them
// (hidden limits, auto-ping). Refreshes every minute; Claude accounts only
// every 10 minutes unless forced (Anthropic rate-limits the usage endpoint).
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  REFRESH_INTERVAL_MS,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getQuotaVisibilityKey,
  getRemainingPercentage,
  parseQuotaData,
} from "../../usage/components/ProviderLimits/utils";
import { STATUS_ORDER, type Status } from "@/ui/status";

export interface QuotaWindow {
  /** Stable key used by the per-provider "hidden limits" setting. */
  key: string;
  name: string;
  /** Remaining 0–100, or null for credit balances / unlimited rows. */
  remaining: number | null;
  used?: number;
  total?: number;
  resetAt?: string | null;
  unlimited?: boolean;
  credit?: { amount: number; currency: string };
}

export interface QuotaAccount {
  id: string;
  provider: string;
  label: string;
  authType: string;
  isActive: boolean;
  plan?: string;
  windows: QuotaWindow[];
  hidden: QuotaWindow[];
  loading: boolean;
  error?: string;
  worst: number | null;
  status: Status;
  nextReset: string | null;
  /** Claude reset grants left, when the account has the program. */
  resetsLeft?: number;
}

export type AutoPing = { reactive: boolean; schedule: Record<string, unknown> | null };

export const LOW = 30;
export const EXHAUSTED = DEPLETED_QUOTA_THRESHOLD;
export const RESETTABLE = new Set(["claude", "codex"]);
export const AUTO_PING_KEYS: Record<string, string> = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

type Raw = Record<string, any>;
interface Entry {
  conn: Raw;
  rows: Raw[];
  plan?: string;
  error?: string;
  loading: boolean;
  fetchedAt: number;
  resetsLeft?: number;
}

const toWindow = (q: Raw): QuotaWindow => ({
  key: getQuotaVisibilityKey(q),
  name: q.name,
  remaining: q.isCreditBalance || q.neverExpires || q.unlimited ? null : getRemainingPercentage(q),
  used: q.used,
  total: q.total,
  resetAt: q.resetAt ?? null,
  unlimited: !!(q.neverExpires || q.unlimited),
  credit: q.isCreditBalance
    ? { amount: Number(q.remaining) || 0, currency: q.currency ?? "USD" }
    : undefined,
});

function build(e: Entry, visibility: Raw): QuotaAccount {
  const c = e.conn;
  // Claude/Kiro report soft failures as a single "error" row.
  const errorRow = e.rows.find((q) => q.name === "error");
  const rows = errorRow ? [] : e.rows;
  const windows = (filterQuotasByVisibility(c.provider, rows, visibility) as Raw[]).map(toWindow);
  const hidden = (getHiddenQuotaRows(c.provider, rows, visibility) as Raw[]).map(toWindow);
  const error = e.error ?? errorRow?.message;
  const pct = windows.map((w) => w.remaining).filter((v): v is number => v != null);
  const worst = pct.length ? Math.min(...pct) : null;
  const now = Date.now();
  const nextReset =
    windows
      .map((w) => w.resetAt)
      .filter((r): r is string => !!r && new Date(r).getTime() > now)
      .sort()[0] ?? null;
  const isActive = c.isActive ?? true;
  let status: Status = "ok";
  if (!isActive) status = "paused";
  else if (e.loading && !e.rows.length && !e.error) status = "pending";
  else if (error) status = "error";
  else if (worst == null) status = windows.length ? "ready" : "none";
  else if (worst <= EXHAUSTED) status = "error";
  else if (worst < LOW) status = "degraded";
  return {
    id: c.id,
    provider: c.provider,
    label: c.name || c.email || c.displayName || c.provider,
    authType: c.authType,
    isActive,
    plan: e.plan,
    windows,
    hidden,
    loading: e.loading,
    error,
    worst,
    status,
    nextReset,
    resetsLeft: e.resetsLeft,
  };
}

export const sortAccounts = (list: QuotaAccount[]) =>
  [...list].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.worst ?? 101) - (b.worst ?? 101) ||
      a.label.localeCompare(b.label),
  );

const json = (r: Response) => r.json().catch(() => ({}));

// Last view, so a return visit paints real (slightly stale) numbers at once and
// updates them in place instead of flashing skeletons. Browser-local; holds the
// same account names and limits the page shows, no credentials.
const CACHE_KEY = "regent.quotaView.v1";
const CONN_FIELDS = ["id", "provider", "authType", "name", "email", "displayName", "isActive"];

function readCache(): { order: string[] | null; entries: Record<string, Entry> } {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!c || !Array.isArray(c.order)) return { order: null, entries: {} };
    const entries: Record<string, Entry> = {};
    for (const [id, e] of Object.entries(c.entries ?? {}) as [string, Raw][])
      entries[id] = {
        conn: e.conn,
        rows: e.rows ?? [],
        plan: e.plan,
        resetsLeft: e.resetsLeft,
        error: e.error,
        loading: true,
        fetchedAt: 0,
      };
    return { order: c.order, entries };
  } catch {
    return { order: null, entries: {} };
  }
}

/** Server list (authoritative for which accounts exist) + cached limits, if any. */
function seedFrom(
  initial: Raw[] | null,
  cached: { order: string[] | null; entries: Record<string, Entry> },
) {
  if (!initial) return cached;
  const entries: Record<string, Entry> = {};
  for (const c of initial) {
    const hit = cached.entries[c.id];
    entries[c.id] = hit ? { ...hit, conn: c } : { conn: c, rows: [], loading: true, fetchedAt: 0 };
  }
  return { order: initial.map((c) => c.id), entries };
}

function writeCache(order: string[], entries: Record<string, Entry>) {
  try {
    const out: Record<string, Raw> = {};
    for (const id of order) {
      const e = entries[id];
      if (!e || e.fetchedAt === 0) continue;
      const conn: Raw = {};
      for (const k of CONN_FIELDS) if (e.conn[k] != null) conn[k] = e.conn[k];
      out[id] = { conn, rows: e.rows, plan: e.plan, resetsLeft: e.resetsLeft, error: e.error };
    }
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ order: order.filter((id) => out[id]), entries: out }),
    );
  } catch {
    // Storage full or blocked: the page still works, it just won't start warm.
  }
}

async function settingsPatch(body: Raw) {
  const r = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Couldn't save settings");
}

export function useQuota(initial: Raw[] | null = null) {
  // The server renders the page with the account list (real rows, placeholder
  // bars). Before the first paint, the last-known limits from this browser are
  // filled in, so a return visit shows numbers immediately.
  const [seed] = useState(() => seedFrom(initial, { order: null, entries: {} }));
  const [entries, setEntries] = useState<Record<string, Entry>>(seed.entries);
  const [order, setOrder] = useState<string[] | null>(seed.order);
  useLayoutEffect(() => {
    const next = seedFrom(initial, readCache());
    // eslint-disable-next-line react/set-state-in-effect -- localStorage is only readable after hydration; a layout effect applies it before paint
    setEntries(next.entries);
    setOrder(next.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  const [visibility, setVisibility] = useState<Raw>({});
  const [autoPing, setAutoPing] = useState<Record<string, Raw>>({ claude: {}, codex: {} });
  const [error, setError] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const fetchOne = useCallback(async (conn: Raw, force: boolean) => {
    setEntries((m) => ({
      ...m,
      [conn.id]: { ...(m[conn.id] ?? { rows: [], fetchedAt: 0 }), conn, loading: true },
    }));
    let next: Partial<Entry>;
    try {
      const r = await fetch(`/api/usage/${conn.id}${force ? "?force=1" : ""}`, {
        cache: "no-store",
      });
      const data = await json(r);
      if (r.status === 401) next = { rows: [], error: "Sign-in expired. Reconnect the account." };
      else if (!r.ok) next = { rows: [], error: data.error || `Couldn't read quota (${r.status})` };
      else {
        const rows = parseQuotaData(conn.provider, data) as Raw[];
        next =
          !rows.length && data.message
            ? { rows: [], error: data.message }
            : {
                rows,
                plan: data.plan,
                error: undefined,
                resetsLeft: data.resetCredits?.availableCount,
              };
      }
    } catch {
      next = { error: "Couldn't reach the server" };
    }
    setEntries((m) => ({
      ...m,
      [conn.id]: { ...(m[conn.id] as Entry), conn, ...next, loading: false, fetchedAt: Date.now() },
    }));
  }, []);

  const load = useCallback(
    async (force = false) => {
      let conns: Raw[];
      try {
        const r = await fetch("/api/providers/client?page=1&pageSize=500&sort=provider", {
          cache: "no-store",
        });
        if (!r.ok) throw new Error();
        conns = (await r.json()).connections ?? [];
        setError(null);
      } catch {
        setError("Couldn't load accounts.");
        return;
      }
      setOrder(conns.map((c) => c.id));
      // Seed rows immediately so the list renders (with skeletons) before quota arrives.
      setEntries((m) => {
        const next = { ...m };
        for (const c of conns)
          next[c.id] = next[c.id]
            ? { ...next[c.id], conn: c }
            : { conn: c, rows: [], loading: true, fetchedAt: 0 };
        return next;
      });
      const now = Date.now();
      const due = conns.filter((c) => {
        const prev = entriesRef.current[c.id];
        if (force || !prev) return true;
        const every = c.provider === "claude" ? CLAUDE_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
        return now - prev.fetchedAt >= every - 1000;
      });
      for (let i = 0; i < due.length; i += 4)
        await Promise.all(due.slice(i, i + 4).map((c) => fetchOne(c, force)));
    },
    [fetchOne],
  );

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    fetch("/api/settings", { cache: "no-store" })
      .then(json)
      .then((s: Raw) => {
        setVisibility(s.quotaVisibility || {});
        setAutoPing({ claude: s.claudeAutoPing || {}, codex: s.codexAutoPing || {} });
      })
      .catch(() => {});
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  useEffect(() => {
    if (!order) return;
    const t = setTimeout(() => writeCache(order, entries), 500);
    return () => clearTimeout(t);
  }, [order, entries]);

  const accounts =
    order?.filter((id) => entries[id]).map((id) => build(entries[id], visibility)) ?? null;

  const refreshOne = useCallback(
    (id: string) => {
      const e = entriesRef.current[id];
      if (e) void fetchOne(e.conn, true);
    },
    [fetchOne],
  );

  const setActive = useCallback(async (ids: string[], isActive: boolean) => {
    await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (!r.ok) throw new Error((await json(r)).error || "Couldn't update the account");
        setEntries((m) =>
          m[id] ? { ...m, [id]: { ...m[id], conn: { ...m[id].conn, isActive } } } : m,
        );
      }),
    );
  }, []);

  /** Spend a reset (Claude grant / Codex credit). The server picks which one. */
  const resetLimit = useCallback(
    async (a: QuotaAccount) => {
      const url =
        a.provider === "claude"
          ? `/api/usage/${a.id}/claude-reset`
          : `/api/usage/${a.id}/codex-reset-credits`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await json(r);
      if (!r.ok) throw new Error(data.message || data.error || "The reset wasn't applied.");
      refreshOne(a.id);
    },
    [refreshOne],
  );

  const setHidden = useCallback(
    async (provider: string, key: string, hide: boolean) => {
      const prev = visibility;
      const set = new Set<string>(prev[provider]?.hidden ?? []);
      if (hide) set.add(key);
      else set.delete(key);
      const next = { ...prev, [provider]: { ...prev[provider], hidden: [...set] } };
      setVisibility(next);
      try {
        await settingsPatch({ quotaVisibility: next });
      } catch (e) {
        setVisibility(prev);
        throw e;
      }
    },
    [visibility],
  );

  const autoPingFor = (a: QuotaAccount): AutoPing => ({
    reactive: autoPing[a.provider]?.connections?.[a.id] === true,
    schedule: autoPing[a.provider]?.schedules?.[a.id] ?? null,
  });

  const saveAutoPing = useCallback(
    async (a: QuotaAccount, { reactive, schedule }: AutoPing) => {
      const key = AUTO_PING_KEYS[a.provider];
      if (!key) return;
      const prev = autoPing;
      const cfg = prev[a.provider] ?? {};
      const nextCfg = {
        ...cfg,
        connections: { ...cfg.connections, [a.id]: reactive },
        schedules: { ...cfg.schedules, [a.id]: schedule },
      };
      setAutoPing({ ...prev, [a.provider]: nextCfg });
      try {
        // Merge onto the server's current value so other fields of the config survive.
        const s = await fetch("/api/settings", { cache: "no-store" }).then(json);
        await settingsPatch({
          [key]: {
            ...s[key],
            connections: nextCfg.connections,
            schedules: nextCfg.schedules,
          },
        });
      } catch (e) {
        setAutoPing(prev);
        throw e;
      }
    },
    [autoPing],
  );

  return {
    accounts,
    error,
    refreshAll: () => load(true),
    refreshOne,
    setActive,
    resetLimit,
    setHidden,
    autoPingFor,
    saveAutoPing,
  };
}

// ---------- formatting ----------

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  kiro: "Kiro",
  github: "GitHub Copilot",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN",
  "vercel-ai-gateway": "Vercel AI Gateway",
  cursor: "Cursor",
  kimi: "Kimi",
  zed: "Zed",
  glm: "GLM",
  minimax: "MiniMax",
  "minimax-code": "MiniMax Code",
  "minimax-code-global": "MiniMax Code (global)",
  "grok-cli": "Grok CLI",
  deepseek: "DeepSeek",
  groq: "Groq",
  ollama: "Ollama",
  "codebuddy-cn": "CodeBuddy CN",
  "codebuddy-intl": "CodeBuddy",
};
export const providerName = (p: string) => PROVIDER_NAMES[p] ?? p;

export function untilText(iso: string | null | undefined, now: number) {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const barTone = (remaining: number | null) =>
  remaining == null
    ? "bg-info"
    : remaining <= EXHAUSTED
      ? "bg-danger"
      : remaining < LOW
        ? "bg-warning"
        : "bg-success";

export const pctText = (w: QuotaWindow) =>
  w.unlimited
    ? "Unlimited"
    : w.credit
      ? `${w.credit.currency === "USD" ? "$" : ""}${w.credit.amount.toFixed(2)}`
      : w.remaining == null
        ? "—"
        : `${Math.round(w.remaining)}%`;

/** "session (5h)" → "Session · 5h". */
export function windowLabel(name: string) {
  const m = name.match(/^(.*?)\s*\((\w+)\)$/);
  const base = (m ? m[1] : name).replace(/_/g, " ");
  const cap = base.charAt(0).toUpperCase() + base.slice(1);
  return m ? `${cap} · ${m[2]}` : cap;
}

/** Re-render every second for countdowns. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
