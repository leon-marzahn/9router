"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Button,
  CodeBlock,
  EmptyState,
  Icon,
  Note,
  Panel,
  SectionTitle,
  Segmented,
  SettingRow,
  SettingRowSkeleton,
  SettingsSection,
  Skeleton,
  StatGrid,
  StatusLabel,
  Tag,
  TopBarActions,
  TopBarContent,
  type Status,
} from "@/ui";

interface PxpipeStatus {
  installed?: boolean;
  installing?: boolean;
  version?: string | null;
  running?: boolean;
  uptimeMs?: number;
  enabled?: boolean;
}

interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string | null;
}

interface PxpipeHealth {
  healthy?: boolean;
  checks?: HealthCheck[];
  error?: string | null;
  code?: "NOT_INSTALLED" | "PIN_MISMATCH" | null;
  pinnedVersion?: string;
}

interface WindowTotals {
  requests: number;
  compressed: number;
  bypassed: number;
  errors: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  imagesGenerated: number;
  avgCompressionMs: number;
}

interface PxpipeEvent {
  ts: number;
  provider?: string;
  model?: string;
  applied?: boolean;
  reason?: string;
  detail?: string;
  tokensBeforeEst?: number;
  tokensAfterEst?: number;
  tokensSavedEst?: number;
  savedPct?: number;
  durationMs?: number | null;
}

type WindowId = "today" | "yesterday" | "last7d" | "last30d" | "all";

interface PxpipeStats {
  windows?: Record<WindowId, WindowTotals>;
  timeline?: { date: string; tokensSavedEst: number }[];
  recent?: PxpipeEvent[];
}

const WINDOWS: { value: WindowId; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7d", label: "7 days" },
  { value: "last30d", label: "30 days" },
  { value: "all", label: "All time" },
];

const REASON_LABELS: Record<string, string> = {
  applied: "Prompt exceeded threshold",
  below_threshold: "Below size threshold",
  not_profitable: "Compression not profitable",
  below_min_chars: "Below minimum chars",
  below_min_tokens: "Below minimum tokens",
  unsupported_model: "Model not in allowlist",
  unsupported_format: "Non-Claude request format",
  timeout: "Compression timed out",
  transform_error: "Transform error",
  passthrough: "Passthrough",
  disabled: "Disabled",
  not_installed: "Not installed",
};

const fmtTokens = (n: number | undefined) => {
  const v = n || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
};

const fmtUptime = (ms: number | undefined) => {
  if (!ms || ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

function overallStatus(
  status: PxpipeStatus | null,
  health: PxpipeHealth | null,
): { status: Status; label: string } {
  if (!status) return { status: "pending", label: "Checking" };
  if (!status.installed) return { status: "none", label: "Not installed" };
  if (health?.healthy) return { status: "ok", label: "Healthy" };
  if (status.running) return { status: "degraded", label: "Running" };
  return { status: "error", label: "Stopped" };
}

function EventTag({ ev }: { ev: PxpipeEvent }) {
  if (ev.applied) return <Tag tone="success">Compressed</Tag>;
  const tone = ev.reason === "transform_error" || ev.reason === "timeout" ? "danger" : "warning";
  return (
    <Tag tone={tone} title={ev.detail || ""}>
      {REASON_LABELS[ev.reason ?? ""] || ev.reason}
    </Tag>
  );
}

const num = "px-4 py-2 text-right font-mono text-[12px] tabular-nums";

export function Pxpipe() {
  const [status, setStatus] = useState<PxpipeStatus | null>(null);
  const [health, setHealth] = useState<PxpipeHealth | null>(null);
  const [stats, setStats] = useState<PxpipeStats | null>(null);
  const [logs, setLogs] = useState<{ installLog?: string } | null>(null);
  const [windowId, setWindowId] = useState<WindowId>("last7d");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, statsRes, logsRes] = await Promise.all([
        fetch("/api/pxpipe/status", { headers: { "Cache-Control": "no-store" } }),
        fetch("/api/pxpipe/stats"),
        fetch("/api/pxpipe/logs?limit=50"),
      ]);
      setStatus(await statusRes.json());
      setStats(await statsRes.json());
      setLogs(await logsRes.json());
      const healthRes = await fetch("/api/pxpipe/health", { method: "POST" });
      setHealth(await healthRes.json());
    } catch {
      /* sections render placeholders */
    } finally {
      setLoading(false);
    }
  }, []);

  // Explicit only: a missing or mismatched copy is never replaced silently.
  const installPinned = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch("/api/pxpipe/install", { method: "POST" });
      const body = await res.json();
      if (!res.ok) setInstallError(body.error || "Install failed");
    } catch {
      setInstallError("Install request failed");
    } finally {
      setInstalling(false);
      void refresh();
    }
  }, [refresh]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- initial data load on mount
    void refresh();
  }, [refresh]);

  const w = stats?.windows?.[windowId];
  const overall = overallStatus(status, health);
  const recent = (stats?.recent || []).slice(0, 50);
  const hasTimeline = stats?.timeline?.some((d) => d.tokensSavedEst > 0);
  const savings: [string, string, boolean][] = [
    ["Original tokens", w ? fmtTokens(w.tokensBeforeEst) : "—", false],
    ["After PXPIPE", w ? fmtTokens(w.tokensAfterEst) : "—", false],
    ["Saved", w ? fmtTokens(w.tokensSavedEst) : "—", true],
    ["Reduction", w ? `${w.savedPct}%` : "—", true],
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <TopBarContent>
        <StatusLabel status={overall.status} label={overall.label} />
      </TopBarContent>
      <TopBarActions>
        <Link
          href="/dashboard/token-saver"
          className="hidden h-8 items-center gap-1.5 rounded-lg px-3 text-xs text-text-muted hover:bg-surface-2 hover:text-text sm:inline-flex"
        >
          Token Saver settings
          <Icon name="arrow_forward" size={16} />
        </Link>
        <Button size="sm" variant="secondary" icon="refresh" onClick={refresh} loading={loading}>
          Refresh
        </Button>
      </TopBarActions>

      <header>
        <h1 className="font-display text-3xl tracking-tight">PXPIPE</h1>
        <p className="mt-1 text-sm text-text-muted">
          Renders large Claude-format prompts as images to cut input tokens.{" "}
          <Link
            href="/dashboard/token-saver"
            className="text-accent-text underline underline-offset-2"
          >
            Token Saver settings
          </Link>
        </p>
      </header>

      <StatGrid
        items={[
          {
            label: "Status",
            value: overall.label,
            sub: status?.enabled ? "Enabled in pipeline" : "Disabled in pipeline",
          },
          {
            label: "Version",
            value: status?.version ? `v${status.version}` : "—",
            sub: "pxpipe-proxy",
          },
          { label: "Uptime", value: fmtUptime(status?.uptimeMs), sub: "module loaded" },
          { label: "Requests", value: w ? w.requests : "—" },
          { label: "Compressed", value: w ? w.compressed : "—" },
          { label: "Bypassed", value: w ? w.bypassed : "—" },
        ]}
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle icon="savings" title="Token savings (estimated)" />
          <Segmented
            value={windowId}
            onChange={setWindowId}
            options={WINDOWS}
            className="w-full sm:ml-auto sm:w-[420px]"
          />
        </div>
        <Panel className="p-5">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {savings.map(([label, value, good]) => (
              <div key={label}>
                <div className="text-xs text-text-muted">{label}</div>
                <div
                  className={
                    good
                      ? "text-xl font-semibold tabular-nums text-success-text"
                      : "text-xl font-semibold tabular-nums"
                  }
                >
                  {value}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-text-muted">
            Estimates from body size before/after imaging; billed usage per request (recorded on the
            Usage page) remains the ground truth. Images generated:{" "}
            {w ? w.imagesGenerated.toLocaleString() : "—"} · avg compression time:{" "}
            {w ? `${w.avgCompressionMs}ms` : "—"} · errors: {w ? w.errors : "—"}
          </p>
        </Panel>
      </section>

      <section className="space-y-3">
        <SectionTitle icon="show_chart" title="Tokens saved, last 30 days" />
        <Panel className="p-5">
          {loading && !stats ? (
            <Skeleton className="h-56 w-full" />
          ) : hasTimeline ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={stats?.timeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradPxpipe" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-success)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--color-success)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  stroke="var(--color-border)"
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  stroke="var(--color-border)"
                  tickFormatter={fmtTokens}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v) => [fmtTokens(Number(v)), "Tokens saved"]}
                />
                <Area
                  type="monotone"
                  dataKey="tokensSavedEst"
                  stroke="var(--color-success)"
                  fill="url(#gradPxpipe)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState icon="image">
              No savings recorded yet. Enable PXPIPE in the Token Saver and route a large
              Claude-format request.
            </EmptyState>
          )}
        </Panel>
      </section>

      <SettingsSection id="health" icon="monitor_heart" title="Health">
        {!health ? (
          <SettingRowSkeleton />
        ) : (
          <>
            {(health.checks || []).map((c) => (
              <SettingRow key={c.id} title={c.label} hint={c.detail || undefined}>
                <StatusLabel status={c.ok ? "ok" : "error"} label={c.ok ? "Passed" : "Failed"} />
              </SettingRow>
            ))}
            {health.error && (
              <div className="py-4">
                <Note tone="danger">{health.error}</Note>
              </div>
            )}
            {(health.code === "NOT_INSTALLED" || health.code === "PIN_MISMATCH") && (
              <SettingRow
                title={
                  health.code === "PIN_MISMATCH"
                    ? "Reinstall pinned version"
                    : "Install pinned version"
                }
                hint={`Installs pxpipe-proxy v${health.pinnedVersion} from registry.npmjs.org with install scripts disabled, then verifies it.`}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  icon="download"
                  onClick={installPinned}
                  loading={installing}
                >
                  {health.code === "PIN_MISMATCH" ? "Reinstall" : "Install"}
                </Button>
              </SettingRow>
            )}
            {installError && (
              <div className="py-4">
                <Note tone="danger">{installError}</Note>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <section className="space-y-3">
        <SectionTitle icon="history" title="History" count={recent.length || undefined} />
        <Panel className="overflow-hidden">
          {recent.length === 0 ? (
            <div className="px-2.5 py-6 text-center text-[12px] text-text-muted">
              No PXPIPE activity yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    <th className="px-4 py-2">Time</th>
                    <th className="px-4 py-2">Model</th>
                    <th className="px-4 py-2 text-right">Original</th>
                    <th className="px-4 py-2 text-right">Compressed</th>
                    <th className="px-4 py-2 text-right">Saved</th>
                    <th className="px-4 py-2 text-right">%</th>
                    <th className="px-4 py-2 text-right">Duration</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {recent.map((ev, i) => (
                    <tr key={`${ev.ts}-${i}`} className="hover:bg-surface-2">
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                        {new Date(ev.ts).toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[12px]">
                        {ev.provider ? `${ev.provider}/${ev.model}` : ev.model || "—"}
                      </td>
                      <td className={num}>{ev.applied ? fmtTokens(ev.tokensBeforeEst) : "—"}</td>
                      <td className={num}>{ev.applied ? fmtTokens(ev.tokensAfterEst) : "—"}</td>
                      <td className={`${num} text-success-text`}>
                        {ev.applied ? fmtTokens(ev.tokensSavedEst) : "—"}
                      </td>
                      <td className={num}>{ev.applied ? `${ev.savedPct}%` : "—"}</td>
                      <td className={num}>{ev.durationMs != null ? `${ev.durationMs}ms` : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <EventTag ev={ev} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <section id="logs" className="space-y-3">
        <SectionTitle icon="terminal" title="Install log" />
        {logs?.installLog ? (
          <CodeBlock
            title="pxpipe install"
            copy={logs.installLog}
            text={logs.installLog}
            wrap
            preClassName="max-h-64"
          />
        ) : (
          <Panel className="px-2.5 py-6 text-center text-[12px] text-text-muted">
            No install log yet.
          </Panel>
        )}
      </section>
    </div>
  );
}
