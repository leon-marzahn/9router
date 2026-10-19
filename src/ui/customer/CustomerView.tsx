"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTheme } from "@/shared/hooks/useTheme";
import { Button, IconButton } from "../Button";
import { cn } from "../cn";
import { Field, Input } from "../Field";
import { Logo } from "../Logo";
import { EmptyState, Eyebrow, Panel, SectionTitle } from "../Panel";
import { Note } from "../SettingRow";
import { Tag } from "../Tag";

// The key lives only in this tab's sessionStorage: never in the URL, never in a cookie.
const STORAGE_KEY = "regent.customerKey";

interface Usage {
  key: { name: string };
  period: {
    period: "day" | "month";
    start: string;
    resetsAt: string;
    spend: number;
    tokens: number;
    requests: number;
  };
  budget: null | {
    enabled: boolean;
    period: "day" | "month";
    spendLimit: number | null;
    tokenLimit: number | null;
    requestLimit: number | null;
    hardStop: boolean;
    ratio: number;
    state: "ok" | "warning" | "over";
    blocked: boolean;
  };
  daily: { date: string; requests: number; tokens: number; spend: number }[];
  byModel: {
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    spend: number;
  }[];
  recent: {
    time: string;
    model: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    spend: number;
  }[];
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 })}`;
const int = (n: number) => n.toLocaleString("en-US");
const utc = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }) + " UTC";

function readKey() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
function writeKey(k: string) {
  try {
    if (k) sessionStorage.setItem(STORAGE_KEY, k);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

async function fetchUsage(key: string): Promise<Usage> {
  const res = await fetch("/api/customer/usage", {
    cache: "no-store",
    credentials: "omit",
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("Too many failed attempts. Wait a while and try again.");
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? "That key wasn't accepted. Check it, or ask your provider whether usage viewing is on for it."
        : data.error || "Couldn't load usage",
    );
  return data as Usage;
}

export function CustomerView() {
  const [key, setKey] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });

  const open = useCallback(async (k: string) => {
    setLoad({ kind: "loading" });
    try {
      const u = await fetchUsage(k);
      writeKey(k);
      setKey(k);
      setUsage(u);
      setLoad({ kind: "idle" });
    } catch (e) {
      writeKey("");
      setUsage(null);
      setLoad({ kind: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    const saved = readKey();
    if (!saved) return;
    const t = setTimeout(() => void open(saved), 0);
    return () => clearTimeout(t);
  }, [open]);

  const signOut = () => {
    writeKey("");
    setKey("");
    setUsage(null);
    setLoad({ kind: "idle" });
  };

  return (
    <div className="min-h-dvh bg-bg text-text">
      <Header onSignOut={usage ? signOut : undefined} />
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 md:px-8">
        {usage ? (
          <Dashboard
            usage={usage}
            refreshing={load.kind === "loading"}
            onRefresh={() => void open(key)}
          />
        ) : (
          <KeyForm load={load} onSubmit={(k) => void open(k)} />
        )}
      </main>
    </div>
  );
}

function Header({ onSignOut }: { onSignOut?: () => void }) {
  const { isDark, toggleTheme } = useTheme() as { isDark: boolean; toggleTheme: () => void };
  return (
    <header className="border-b border-border bg-bg-alt">
      <div className="mx-auto flex h-12 w-full max-w-5xl items-center gap-2.5 px-4 md:px-8">
        <Logo size={26} />
        <span className="font-display text-lg tracking-tight">Elizabeth&apos;s Proxy</span>
        <span className="text-[12px] text-text-muted max-sm:hidden">Usage</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={isDark ? "light_mode" : "dark_mode"}
            label={isDark ? "Light theme" : "Dark theme"}
            onClick={toggleTheme}
          />
          {onSignOut && (
            <Button variant="ghost" icon="logout" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function KeyForm({ load, onSubmit }: { load: Load; onSubmit: (k: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = value.trim();
    if (k) onSubmit(k);
  };
  return (
    <div className="mx-auto max-w-md pt-6 md:pt-16">
      <h1 className="font-display text-3xl tracking-tight">Your usage</h1>
      <p className="mt-1 text-sm text-text-muted">
        Enter the API key you use for requests to see your spend, budget and recent requests.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field
          label="API key"
          hint="Kept in this browser tab only and sent just to this server."
          error={load.kind === "error" ? load.message : undefined}
        >
          <Input
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-…"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="md"
          icon="arrow_forward"
          loading={load.kind === "loading"}
          disabled={!value.trim()}
        >
          View usage
        </Button>
      </form>
    </div>
  );
}

function Dashboard({
  usage,
  refreshing,
  onRefresh,
}: {
  usage: Usage;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const p = usage.period;
  const periodLabel = p.period === "day" ? "Today" : "This month";
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-3xl tracking-tight">{usage.key.name}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {periodLabel} (UTC): <strong className="text-text">{money(p.spend)}</strong> across{" "}
            {int(p.requests)} requests and {int(p.tokens)} tokens.
          </p>
        </div>
        <Button icon="refresh" onClick={onRefresh} loading={refreshing}>
          Refresh
        </Button>
      </div>

      <BudgetPanel usage={usage} />

      <section className="space-y-3">
        <SectionTitle icon="bar_chart" title="Spend, last 30 days" />
        <Panel className="p-4 md:p-5">
          <DailyChart daily={usage.daily} />
        </Panel>
      </section>

      <section className="space-y-3">
        <SectionTitle icon="category" title={`By model, ${periodLabel.toLowerCase()}`} />
        {usage.byModel.length ? (
          <ModelTable rows={usage.byModel} />
        ) : (
          <EmptyState icon="category">No requests this period yet.</EmptyState>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle icon="receipt_long" title="Recent requests" count={usage.recent.length} />
        {usage.recent.length ? (
          <RecentList rows={usage.recent} />
        ) : (
          <EmptyState icon="receipt_long">No requests yet.</EmptyState>
        )}
      </section>
    </div>
  );
}

function BudgetPanel({ usage }: { usage: Usage }) {
  const b = usage.budget;
  const p = usage.period;
  const period = p.period === "day" ? "today" : "this month";
  if (!b) {
    return (
      <Panel className="space-y-1 p-5">
        <Eyebrow>Spend {period}</Eyebrow>
        <div className="text-3xl font-semibold tabular-nums">{money(p.spend)}</div>
        <div className="text-[12px] text-text-muted">
          No budget set on this key. The period resets {utc(p.resetsAt)}.
        </div>
      </Panel>
    );
  }
  const pct = Math.min(100, Math.round(b.ratio * 100));
  const bar =
    b.state === "over" ? "bg-danger" : b.state === "warning" ? "bg-warning" : "bg-success";
  const limits = [
    b.spendLimit != null && `${money(p.spend)} of ${money(b.spendLimit)}`,
    b.tokenLimit != null && `${int(p.tokens)} of ${int(b.tokenLimit)} tokens`,
    b.requestLimit != null && `${int(p.requests)} of ${int(b.requestLimit)} requests`,
  ].filter(Boolean) as string[];
  return (
    <Panel className="space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Budget {period}</Eyebrow>
        {b.blocked ? (
          <Tag tone="danger">Limit reached</Tag>
        ) : b.state === "warning" ? (
          <Tag tone="warning">Nearing limit</Tag>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-semibold tabular-nums">{money(p.spend)}</span>
        {b.spendLimit != null && (
          <span className="text-sm text-text-muted tabular-nums">of {money(b.spendLimit)}</span>
        )}
        <span
          className={cn(
            "ml-auto text-sm tabular-nums",
            b.state === "over" ? "text-danger-text" : "text-text-muted",
          )}
        >
          {pct}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Budget used ${period}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div className={cn("h-full rounded-full", bar)} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[12px] text-text-muted">{limits.join(" · ")}</div>
      <div className="text-[12px] text-text-muted">Resets {utc(p.resetsAt)}</div>
      {b.blocked && <Note tone="danger">New requests are refused until the budget resets.</Note>}
      {!b.enabled && <Note tone="warning">This budget is paused and not enforced.</Note>}
    </Panel>
  );
}

function DailyChart({ daily }: { daily: Usage["daily"] }) {
  const max = Math.max(...daily.map((d) => d.spend), 0);
  const total = daily.reduce((s, d) => s + d.spend, 0);
  const reqs = daily.reduce((s, d) => s + d.requests, 0);
  if (!reqs)
    return (
      <p className="py-6 text-center text-[12px] text-text-muted">
        No requests in the last 30 days.
      </p>
    );
  // Spend is zero when nothing is priced; fall back to request counts so the chart still says something.
  const metric = max > 0 ? "spend" : "requests";
  const peak = metric === "spend" ? max : Math.max(...daily.map((d) => d.requests));
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between text-[12px] text-text-muted">
        <span>{metric === "spend" ? money(total) : `${int(reqs)} requests`} in 30 days</span>
        <span>Peak {metric === "spend" ? money(peak) : int(peak)}/day</span>
      </div>
      <div
        className="flex h-36 items-end gap-[2px]"
        role="img"
        aria-label={`Daily ${metric}, last 30 days`}
      >
        {daily.map((d) => {
          const v = metric === "spend" ? d.spend : d.requests;
          const h = peak ? Math.max(v > 0 ? 3 : 0, (v / peak) * 100) : 0;
          return (
            <div
              key={d.date}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              title={`${d.date}: ${money(d.spend)} · ${int(d.requests)} requests · ${int(d.tokens)} tokens`}
            >
              <div
                className="w-full rounded-t-sm bg-accent/80 group-hover:bg-accent"
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-text-subtle tabular-nums">
        <span>{daily[0]?.date.slice(5)}</span>
        <span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function ModelTable({ rows }: { rows: Usage["byModel"] }) {
  return (
    <Panel className="divide-y divide-border-subtle">
      <div className="hidden grid-cols-[1fr_6rem_9rem_7rem] gap-3 px-5 py-2 text-[11px] font-medium uppercase tracking-wider text-text-muted md:grid">
        <span>Model</span>
        <span className="text-right">Requests</span>
        <span className="text-right">Tokens in / out</span>
        <span className="text-right">Spend</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.model}
          className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-3 text-[13px] md:grid-cols-[1fr_6rem_9rem_7rem] md:px-5"
        >
          <span className="min-w-0 truncate font-mono text-[12px]">{r.model}</span>
          <span className="text-right tabular-nums md:order-last">{money(r.spend)}</span>
          <span className="text-[12px] text-text-muted tabular-nums md:text-right md:text-[13px] md:text-text">
            {int(r.requests)}
            <span className="md:hidden"> requests</span>
          </span>
          <span className="text-right text-[12px] text-text-muted tabular-nums md:text-[13px]">
            {int(r.inputTokens)} / {int(r.outputTokens)}
          </span>
        </div>
      ))}
    </Panel>
  );
}

function RecentList({ rows }: { rows: Usage["recent"] }) {
  return (
    <Panel className="divide-y divide-border-subtle">
      {rows.map((r, i) => {
        const ok = r.status === "ok" || r.status === "success" || /^2\d\d$/.test(r.status);
        return (
          <div
            key={`${r.time}:${i}`}
            className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px] md:grid-cols-[9rem_1fr_auto_8rem_5rem] md:px-5"
          >
            <span className="text-[12px] text-text-muted tabular-nums max-md:order-3">
              {utc(r.time)}
            </span>
            <span className="min-w-0 truncate font-mono text-[12px]">{r.model}</span>
            <span className="max-md:order-4 max-md:justify-self-end">
              <Tag tone={ok ? "success" : "danger"} mono>
                {r.status}
              </Tag>
            </span>
            <span className="text-[12px] text-text-muted tabular-nums max-md:hidden md:text-right">
              {int(r.inputTokens)} / {int(r.outputTokens)}
            </span>
            <span className="text-right tabular-nums max-md:order-2">{money(r.spend)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
