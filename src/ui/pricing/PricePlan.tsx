"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, IconButton } from "../Button";
import { Dialog } from "../Dialog";
import { Field, Input } from "../Field";

/**
 * One custom rate, USD per 1M tokens. `model` is written the way clients route:
 * "prefix/model" (provider id, alias like "cc", or a compatible node's prefix) or a bare model id.
 */
export interface PlanRate {
  model: string;
  input: number;
  output: number;
  cached: number | null;
}
export interface PricePlan {
  name: string;
  markupPercent: number;
  minFee: number | null;
  rates: PlanRate[];
}
interface PlanList {
  plans: Record<string, PricePlan>;
  keyPlans: Record<string, string>;
  /** Saved rate model text -> provider name it routes to, or null for a bare model id. */
  resolved?: Record<string, string | null>;
}

export const DEFAULT_PLAN_ID = "default";

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

/** Price plans, the default plan, and which plan each key (by id) is on. */
export function usePricePlans() {
  const [list, setList] = useState<PlanList | null>(null);
  const reload = useCallback(async () => {
    try {
      setList(await json("/api/pricing/plans"));
    } catch {
      setList({ plans: {}, keyPlans: {}, resolved: {} });
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  /** `id` null creates a plan; returns its id. */
  const save = useCallback(
    async (id: string | null, plan: PricePlan): Promise<string> => {
      const out = id
        ? await json(`/api/pricing/plans/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: JSON.stringify(plan),
          })
        : await json("/api/pricing/plans", { method: "POST", body: JSON.stringify(plan) });
      await reload();
      return out.id;
    },
    [reload],
  );
  const remove = useCallback(
    async (id: string) => {
      await json(`/api/pricing/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
      await reload();
    },
    [reload],
  );
  const assign = useCallback(
    async (keyId: string, planId: string) => {
      await json(`/api/keys/${encodeURIComponent(keyId)}/plan`, {
        method: "PUT",
        body: JSON.stringify({ planId }),
      });
      await reload();
    },
    [reload],
  );
  return { list, reload, save, remove, assign };
}

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

/** "+25% over cost · min $0.01 · 2 custom rates" */
export function planSummary(p: PricePlan) {
  const parts = [p.markupPercent ? `+${p.markupPercent}% over cost` : "At cost"];
  if (p.minFee) parts.push(`min ${usd(p.minFee)} / request`);
  if (p.rates.length) parts.push(`${p.rates.length} custom rate${p.rates.length > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

const toText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
const toNum = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[$,%\s]/g, "")));

interface RateDraft {
  model: string;
  input: string;
  output: string;
  cached: string;
}

/** Name, markup, minimum fee and custom per-model rates. */
export function PlanEditor({
  initial,
  fixedName,
  resolved = {},
  onSave,
  onRemove,
  onCancel,
  saveLabel = "Save plan",
  removeLabel = "Delete plan",
}: {
  initial: PricePlan | null;
  /** The default plan keeps its name. */
  fixedName?: string;
  resolved?: Record<string, string | null>;
  onSave: (p: PricePlan) => Promise<void>;
  onRemove?: () => Promise<void>;
  onCancel?: () => void;
  saveLabel?: string;
  removeLabel?: string;
}) {
  const [name, setName] = useState(fixedName ?? initial?.name ?? "");
  const [markup, setMarkup] = useState(toText(initial?.markupPercent ?? 0));
  const [minFee, setMinFee] = useState(toText(initial?.minFee));
  const [rates, setRates] = useState<RateDraft[]>(
    (initial?.rates ?? []).map((r) => ({
      model: r.model,
      input: toText(r.input),
      output: toText(r.output),
      cached: toText(r.cached),
    })),
  );
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const [error, setError] = useState<string | null>(null);
  const setRate = (i: number, patch: Partial<RateDraft>) =>
    setRates(rates.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    setBusy("save");
    setError(null);
    try {
      await onSave({
        name: fixedName ?? name,
        markupPercent: toNum(markup) ?? 0,
        minFee: toNum(minFee),
        rates: rates
          .filter((r) => r.model.trim() || r.input || r.output)
          .map((r) => ({
            model: r.model.trim(),
            input: toNum(r.input) as number,
            output: toNum(r.output) as number,
            cached: toNum(r.cached),
          })),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {!fixedName && (
        <Field label="Name">
          <Input
            value={name}
            maxLength={60}
            placeholder="Pro"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Markup (%)" hint="Added to what the request cost upstream.">
          <Input
            inputMode="decimal"
            value={markup}
            placeholder="0"
            onChange={(e) => setMarkup(e.target.value)}
          />
        </Field>
        <Field label="Minimum per request (USD)" hint="Optional. Empty, failed requests are free.">
          <Input
            inputMode="decimal"
            value={minFee}
            placeholder="0.001"
            onChange={(e) => setMinFee(e.target.value)}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-xs font-medium">Custom rates</div>
          <div className="text-[11px] text-text-muted">
            USD per 1M tokens, replacing cost + markup for that model. Write the model the way
            clients call it: <span className="font-mono">prefix/model</span> (provider, alias such
            as <span className="font-mono">cc</span>, or your node&apos;s prefix) for one provider,
            or a bare model id for any provider. A prefixed rate wins over a bare one.
          </div>
        </div>
        {rates.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_auto] gap-2 rounded-lg bg-bg-alt p-2 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] sm:items-center sm:bg-transparent sm:p-0"
          >
            <Input
              mono
              aria-label="Model"
              value={r.model}
              placeholder="prefix/model or model"
              onChange={(e) => setRate(i, { model: e.target.value })}
            />
            <IconButton
              icon="close"
              label={`Remove ${r.model || "rate"}`}
              className="sm:order-last"
              onClick={() => setRates(rates.filter((_, j) => j !== i))}
            />
            <div className="col-span-2 grid grid-cols-3 gap-2 sm:col-span-3 sm:contents">
              {(["input", "output", "cached"] as const).map((f) => (
                <Input
                  key={f}
                  inputMode="decimal"
                  aria-label={`${f} price per 1M`}
                  value={r[f]}
                  placeholder={f === "cached" ? "Cached" : f === "input" ? "Input" : "Output"}
                  onChange={(e) => setRate(i, { [f]: e.target.value })}
                />
              ))}
            </div>
            {r.model.trim() && (
              <div className="col-span-2 text-[11px] text-text-subtle sm:col-span-5">
                {r.model in resolved
                  ? resolved[r.model]
                    ? `Only via ${resolved[r.model]}`
                    : "Bare model id: any provider"
                  : "Checked when saved"}
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRates([...rates, { model: "", input: "", output: "", cached: "" }])}
          className="rounded-md border border-dashed border-border-strong px-2 py-1 text-[12px] text-text-muted hover:border-accent hover:text-accent-text max-md:min-h-10 max-md:w-full"
        >
          Add rate…
        </button>
      </div>

      <p className="text-[11px] text-text-subtle">
        Charges are fixed when each request is recorded: edits apply to new requests only.
      </p>
      {error && <div className="text-[12px] text-danger-text">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
        <Button
          variant="primary"
          size="sm"
          icon="save"
          loading={busy === "save"}
          onClick={() => void submit()}
        >
          {saveLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {onRemove && (
          <Button
            variant="ghost"
            size="sm"
            icon="delete"
            loading={busy === "remove"}
            className="md:ml-auto"
            onClick={() => {
              setBusy("remove");
              void onRemove().finally(() => setBusy(null));
            }}
          >
            {removeLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Plan editor in a dialog (bottom sheet on mobile). */
export function PlanDialog({
  title,
  description,
  initial,
  fixedName,
  resolved,
  onClose,
  onSave,
  onRemove,
}: {
  title: string;
  description?: string;
  initial: PricePlan | null;
  fixedName?: string;
  resolved?: Record<string, string | null>;
  onClose: () => void;
  onSave: (p: PricePlan) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      description={description ?? "What customers on this plan pay per request."}
    >
      <PlanEditor
        initial={initial}
        fixedName={fixedName}
        resolved={resolved}
        onCancel={onClose}
        onSave={async (p) => {
          await onSave(p);
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
