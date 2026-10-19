"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../Button";
import { cn } from "../cn";
import { Dialog } from "../Dialog";
import { Field, Input } from "../Field";
import { Segmented } from "../Segmented";
import { Note } from "../SettingRow";
import { Switch } from "../Switch";

export type BudgetPeriod = "day" | "month";
export interface Budget {
  enabled: boolean;
  period: BudgetPeriod;
  spendLimit: number | null;
  tokenLimit: number | null;
  requestLimit: number | null;
  warnAt: number[];
  hardStop: boolean;
  contactEmail: string;
}
export interface BudgetStatus {
  periodStart: string;
  resetsAt: string;
  /** Upstream cost this period. */
  cost: number;
  /** What the customer was charged this period (= cost for global). */
  charge?: number;
  /** What the spend limit measures: charge for a key, cost for global. */
  spend?: number;
  spendBasis?: "charge" | "cost";
  tokens: number;
  requests: number;
  ratio: number;
  state: "ok" | "warning" | "over";
  blocked: boolean;
  /** "provider/model" used this period without a price: the spend limit doesn't count them. */
  unpricedModels?: string[];
}
export interface BudgetEntry {
  budget: Budget;
  status: BudgetStatus;
}
interface BudgetList {
  global: BudgetEntry | null;
  keys: Record<string, BudgetEntry>;
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't save");
  return data;
}

/** Budgets + their current-period status. `scope` is "global" or an API key id. */
export function useBudgets() {
  const [list, setList] = useState<BudgetList | null>(null);
  const reload = useCallback(async () => {
    try {
      setList(await json("/api/budgets"));
    } catch {
      setList({ global: null, keys: {} });
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    const i = setInterval(() => void reload(), 30_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [reload]);

  const save = useCallback(
    async (scope: string, budget: Partial<Budget>) => {
      await json(`/api/budgets/${encodeURIComponent(scope)}`, {
        method: "PUT",
        body: JSON.stringify(budget),
      });
      await reload();
    },
    [reload],
  );
  const remove = useCallback(
    async (scope: string) => {
      await json(`/api/budgets/${encodeURIComponent(scope)}`, { method: "DELETE" });
      await reload();
    },
    [reload],
  );
  return { list, reload, save, remove };
}

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const count = (n: number) => n.toLocaleString();

/** The metric closest to its limit, as "spent of limit". */
function headline(b: Budget, s: BudgetStatus) {
  const rows: [number, string][] = [];
  const spend = s.spend ?? s.cost;
  const what = s.spendBasis === "charge" ? " charged" : "";
  if (b.spendLimit)
    rows.push([spend / b.spendLimit, `${money(spend)} of ${money(b.spendLimit)}${what}`]);
  if (b.tokenLimit)
    rows.push([s.tokens / b.tokenLimit, `${count(s.tokens)} of ${count(b.tokenLimit)} tokens`]);
  if (b.requestLimit)
    rows.push([
      s.requests / b.requestLimit,
      `${count(s.requests)} of ${count(b.requestLimit)} requests`,
    ]);
  rows.sort((a, z) => z[0] - a[0]);
  return rows[0]?.[1] ?? "";
}

/** "Oct 31, 2026, 12:00 AM UTC" */
export const utc = (iso: string) =>
  `${new Date(iso).toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;

/** Models used this period that have no price, so a spend limit can't see them. */
export function UnpricedNote({ models }: { models: string[] }) {
  return (
    <Note tone="warning">
      Unpriced models: <span className="font-mono">{models.join(", ")}</span>. Spend limits
      don&apos;t count them;{" "}
      <a href="/dashboard/settings/pricing" className="underline underline-offset-2">
        set pricing
      </a>{" "}
      or add a token or request limit.
    </Note>
  );
}

/** Period spend vs limit: one line of text and a bar colored by state. */
export function BudgetMeter({ entry, className }: { entry: BudgetEntry; className?: string }) {
  const { budget: b, status: s } = entry;
  const pct = Math.min(100, Math.round(s.ratio * 100));
  const tone =
    s.state === "over" ? "bg-danger" : s.state === "warning" ? "bg-warning" : "bg-success";
  const period = b.period === "day" ? "today" : "this month";
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="min-w-0 truncate tabular-nums">
          {headline(b, s)} <span className="text-text-muted">{period}</span>
        </span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            s.state === "over"
              ? "text-danger-text"
              : s.state === "warning"
                ? "text-warning-text"
                : "text-text-muted",
          )}
        >
          {s.blocked ? "Blocked" : `${pct}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`Budget used ${period}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-text-subtle">
        {b.enabled ? `Resets ${utc(s.resetsAt)}` : "Paused: not enforced"}
      </div>
      {!!s.unpricedModels?.length && <UnpricedNote models={s.unpricedModels} />}
    </div>
  );
}

const toText = (n: number | null) => (n === null || n === undefined ? "" : String(n));
const toNum = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[$,\s]/g, "")));

/** Inline budget form. `forKey` adds the customer contact email. */
export function BudgetEditor({
  initial,
  forKey,
  onSave,
  onRemove,
  onCancel,
}: {
  initial: Budget | null;
  forKey: boolean;
  onSave: (b: Partial<Budget>) => Promise<void>;
  onRemove?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [period, setPeriod] = useState<BudgetPeriod>(initial?.period ?? "month");
  const [spend, setSpend] = useState(toText(initial?.spendLimit ?? null));
  const [tokens, setTokens] = useState(toText(initial?.tokenLimit ?? null));
  const [requests, setRequests] = useState(toText(initial?.requestLimit ?? null));
  const [warn, setWarn] = useState((initial?.warnAt ?? [80]).join(", "));
  const [hardStop, setHardStop] = useState(initial?.hardStop ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [contact, setContact] = useState(initial?.contactEmail ?? "");
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy("save");
    setError(null);
    try {
      await onSave({
        enabled,
        period,
        spendLimit: toNum(spend),
        tokenLimit: toNum(tokens),
        requestLimit: toNum(requests),
        warnAt: warn
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((x) => Number(x.replace("%", ""))),
        hardStop,
        ...(forKey ? { contactEmail: contact.trim() } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Field
        label="Period"
        hint="Resets at 00:00 UTC (daily) or on the 1st of the month, 00:00 UTC (monthly)."
      >
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: "day", label: "Daily" },
            { value: "month", label: "Monthly" },
          ]}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Spend limit (USD)"
          hint={forKey ? "What the customer is charged." : "Upstream cost."}
        >
          <Input
            inputMode="decimal"
            value={spend}
            placeholder="50"
            onChange={(e) => setSpend(e.target.value)}
          />
        </Field>
        <Field label="Token limit">
          <Input
            inputMode="numeric"
            value={tokens}
            placeholder="Optional"
            onChange={(e) => setTokens(e.target.value)}
          />
        </Field>
        <Field label="Request limit">
          <Input
            inputMode="numeric"
            value={requests}
            placeholder="Optional"
            onChange={(e) => setRequests(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Warn at (%)"
        hint="Up to three, e.g. 50, 80. An email goes out once per threshold per period."
      >
        <Input value={warn} placeholder="80" onChange={(e) => setWarn(e.target.value)} />
      </Field>
      {forKey && (
        <Field
          label="Customer email (optional)"
          hint="Gets the same alerts as the admin, for this key only."
        >
          <Input
            type="email"
            value={contact}
            autoComplete="off"
            placeholder="billing@customer.com"
            onChange={(e) => setContact(e.target.value)}
          />
        </Field>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">Hard stop</div>
          <div className="text-[12px] text-text-muted">
            Refuse requests (429 <code className="font-mono">budget_exceeded</code>) once a limit is
            reached. Off: alerts only.
          </div>
        </div>
        <Switch checked={hardStop} onChange={setHardStop} label="Hard stop" />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">Enforced</div>
          <div className="text-[12px] text-text-muted">
            Pause to keep the settings without alerts or blocking.
          </div>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="Budget enforced" />
      </div>
      {error && <div className="text-[12px] text-danger-text">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
        <Button
          variant="primary"
          size="sm"
          icon="save"
          loading={busy === "save"}
          onClick={() => void submit()}
        >
          Save budget
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {onRemove && initial && (
          <Button
            variant="ghost"
            size="sm"
            icon="delete"
            loading={busy === "remove"}
            className="md:ml-auto"
            onClick={() => {
              setBusy("remove");
              onRemove().finally(() => setBusy(null));
            }}
          >
            Remove budget
          </Button>
        )}
      </div>
    </div>
  );
}

/** Budget editor in a dialog (bottom sheet on mobile). */
export function BudgetDialog({
  title,
  unpriced,
  initial,
  forKey,
  onClose,
  onSave,
  onRemove,
}: {
  title: string;
  unpriced?: string[];
  initial: Budget | null;
  forKey: boolean;
  onClose: () => void;
  onSave: (b: Partial<Budget>) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      description="Spend, token and request limits for one period."
    >
      {!!unpriced?.length && (
        <div className="mb-4">
          <UnpricedNote models={unpriced} />
        </div>
      )}
      <BudgetEditor
        initial={initial}
        forKey={forKey}
        onCancel={onClose}
        onSave={async (b) => {
          await onSave(b);
          onClose();
        }}
        onRemove={
          onRemove
            ? async () => {
                await onRemove();
                onClose();
              }
            : undefined
        }
      />
    </Dialog>
  );
}
