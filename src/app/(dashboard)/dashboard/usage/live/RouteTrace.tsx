// "How it was routed" block of the request drawer: requested model → combo
// expansion → each upstream attempt in order, with why it fell back.
// Metadata only; bodies stay in the drawer's opt-in sections below.
"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Icon, StatusDot, Tag, cn } from "@/ui";
import { fmtCost, fmtTokens } from "./useUsage";

interface TraceTokens {
  in?: number;
  out?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  credits?: number;
}

export interface TraceAttempt {
  index: number;
  provider?: string;
  model?: string;
  connectionId?: string;
  connectionLabel?: string;
  /** Resolved at read time: node name or registry display name. */
  providerName?: string;
  /** Exact model id sent upstream (aliases/thinking suffixes resolved). */
  upstreamModel?: string;
  /** What the client (or combo step) asked for, when it differs. */
  requestedModel?: string;
  sourceFormat?: string;
  targetFormat?: string;
  passthrough?: boolean;
  stream?: boolean;
  status: "pending" | "ok" | "streaming" | "error";
  statusCode?: number;
  error?: string;
  reason?: string;
  fallback?: string;
  skipped?: boolean;
  latencyMs?: number;
  ttftMs?: number;
  offsetMs?: number;
  tokens?: TraceTokens;
}

export interface Trace {
  id: string;
  requestedModel?: string;
  endpoint?: string;
  combo?: { name?: string; strategy?: string; models: string[] };
  attempts: TraceAttempt[];
  truncatedAttempts?: number;
  outcome: { status: string; statusCode?: number };
  stream?: boolean;
  tokens?: TraceTokens;
  totalLatencyMs?: number;
  cost?: number;
}

const REASONS: Record<string, string> = {
  rate_limit: "rate limited",
  auth: "auth failed",
  server: "upstream error",
  unavailable: "unavailable",
  cooldown: "all accounts cooling down",
  client: "rejected",
  aborted: "client aborted",
  error: "failed",
};

const secs = (ms?: number) =>
  ms == null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;

export function RouteTrace({ traceId }: { traceId?: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "ready">(
    traceId ? "loading" : "missing",
  );

  useEffect(() => {
    if (!traceId) return;
    let alive = true;
    fetch(`/api/usage/traces/${encodeURIComponent(traceId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((t: Trace) => {
        if (!alive) return;
        setTrace(t);
        setState("ready");
      })
      .catch(() => alive && setState("missing"));
    return () => {
      alive = false;
    };
  }, [traceId]);

  if (state === "loading") return <p className="text-sm text-text-muted">Loading route…</p>;
  if (state === "missing" || !trace)
    return (
      <p className="text-[12px] text-text-muted">
        No routing trace for this request. Traces are kept up to the same limit as logged requests
        (Settings → Request logging).
      </p>
    );
  return <RouteTraceView trace={trace} />;
}

export function RouteTraceView({ trace }: { trace: Trace }) {
  const ok = trace.outcome.status === "ok";
  const t = trace.tokens;
  return (
    <section aria-label="How this request was routed" className="space-y-3">
      <Eyebrow>Route</Eyebrow>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className="font-mono break-all">{trace.requestedModel ?? "—"}</span>
        {trace.combo && (
          <>
            <Icon name="arrow_forward" size={14} className="text-text-subtle" />
            <Tag mono title={trace.combo.models.join(", ")}>
              combo · {trace.combo.strategy ?? "fallback"} · {trace.combo.models.length} models
            </Tag>
          </>
        )}
        <span className="ml-auto flex items-center gap-2 text-text-muted">
          <Tag mono>{trace.stream ? "stream" : "json"}</Tag>
          <Tag tone={ok ? "success" : "danger"} mono>
            {trace.outcome.statusCode ?? (ok ? "OK" : "ERR")}
          </Tag>
        </span>
      </div>

      {trace.combo && trace.combo.models.length > 0 && (
        <ol className="flex flex-wrap gap-1 text-[11px]">
          {trace.combo.models.map((m, i) => (
            <li
              key={`${m}-${i}`}
              className="rounded bg-bg-alt px-1.5 py-0.5 font-mono text-text-muted"
            >
              {i + 1}. {m}
            </li>
          ))}
        </ol>
      )}

      <ol className="relative space-y-2">
        {trace.attempts.map((a, i) => (
          <AttemptRow key={a.index} attempt={a} last={i === trace.attempts.length - 1} />
        ))}
      </ol>
      {trace.truncatedAttempts ? (
        <p className="text-[11px] text-text-subtle">
          +{trace.truncatedAttempts} more attempts not recorded
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-bg-alt px-4 py-3 text-[12px] sm:grid-cols-3">
        <Fact label="Attempts" value={String(trace.attempts.length)} />
        <Fact label="Total latency" value={secs(trace.totalLatencyMs)} />
        <Fact label="Cost" value={trace.cost ? fmtCost(trace.cost) : "—"} />
        <Fact label="In" value={t?.in != null ? fmtTokens(t.in) : "—"} />
        <Fact label="Out" value={t?.out != null ? fmtTokens(t.out) : "—"} />
        <Fact label="Cached" value={t?.cached ? fmtTokens(t.cached) : "—"} />
        <Fact label="Reasoning" value={t?.reasoning ? fmtTokens(t.reasoning) : "—"} />
      </dl>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function AttemptRow({ attempt: a, last }: { attempt: TraceAttempt; last: boolean }) {
  const failed = a.status === "error";
  const status = failed ? "error" : a.status === "pending" ? "pending" : "ok";
  const pair =
    a.sourceFormat && a.targetFormat
      ? a.passthrough
        ? `${a.sourceFormat} (passthrough)`
        : `${a.sourceFormat} → ${a.targetFormat}`
      : null;
  return (
    <li
      className={cn(
        "rounded-xl border px-3 py-2.5",
        failed ? "border-danger-border bg-danger-soft" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <StatusDot status={status} live={a.status === "streaming"} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <span className="text-text-subtle tabular-nums">#{a.index + 1}</span>
            <span className="font-medium break-all" title={a.provider}>
              {a.providerName ?? a.provider ?? "—"}
            </span>
            <span
              className="min-w-0 break-all font-mono text-[12px] text-text-muted"
              title="Model id sent upstream"
            >
              {a.upstreamModel ?? a.model}
            </span>
            {a.requestedModel && a.requestedModel !== (a.upstreamModel ?? a.model) && (
              <span className="min-w-0 break-all text-[11px] text-text-subtle">
                for <span className="font-mono">{a.requestedModel}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted">
            {a.connectionLabel && (
              <span className="flex items-center gap-1">
                <Icon name="person" size={12} />
                {a.connectionLabel}
              </span>
            )}
            {pair && <span className="font-mono">{pair}</span>}
            {a.stream != null && <span>{a.stream ? "stream" : "json"}</span>}
            {a.ttftMs != null && <span className="tabular-nums">TTFT {secs(a.ttftMs)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {a.statusCode != null ? (
            <Tag tone={failed ? "danger" : "success"} mono>
              {a.statusCode}
            </Tag>
          ) : (
            <Tag mono>{a.status}</Tag>
          )}
          <span className="text-[11px] tabular-nums text-text-subtle">{secs(a.latencyMs)}</span>
        </div>
      </div>
      {failed && (a.error || a.reason) && (
        <p className="mt-1.5 break-words pl-4 text-[12px] text-danger-text">
          {a.reason && <span className="font-medium">{REASONS[a.reason] ?? a.reason}</span>}
          {a.reason && a.error && " · "}
          {a.error}
        </p>
      )}
      {failed && a.fallback && !last && (
        <p className="mt-1 flex items-center gap-1 pl-4 text-[11px] text-text-muted">
          <Icon name="subdirectory_arrow_right" size={14} />
          fell back to the next {a.fallback === "model" ? "model" : "account"}
        </p>
      )}
      {a.skipped && <p className="mt-1 pl-4 text-[11px] text-text-muted">no request sent</p>}
    </li>
  );
}
