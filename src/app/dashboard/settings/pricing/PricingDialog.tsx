"use client";

import { useEffect, useMemo, useState } from "react";
import { getDefaultPricing } from "open-sse/providers/pricing.js";
import { Button, ConfirmDialog, Dialog, Input, Note, SearchInput, Select, Skeleton } from "@/ui";

type Rates = Partial<Record<Field, number>>;
type Pricing = Record<string, Record<string, Rates>>;
type Field = (typeof FIELDS)[number]["key"];

const FIELDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cached", label: "Cached" },
  { key: "reasoning", label: "Reasoning" },
  { key: "cache_creation", label: "Cache write" },
] as const;

/** Editor for the per-model $/1M token rates behind cost tracking (`/api/pricing`). */
export default function PricingDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave?: () => void;
}) {
  const [pricing, setPricing] = useState<Pricing>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      let data: Pricing;
      try {
        const res = await fetch("/api/pricing");
        data = res.ok ? await res.json() : (getDefaultPricing() as Pricing);
      } catch (err) {
        console.error("Failed to load pricing:", err);
        data = getDefaultPricing() as Pricing;
      }
      if (cancelled) return;
      setPricing(data);
      setProvider((p) => (p && data[p] ? p : (Object.keys(data).sort()[0] ?? "")));
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const providers = useMemo(() => Object.keys(pricing).sort(), [pricing]);
  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.keys(pricing[provider] ?? {})
      .sort()
      .filter((m) => !q || m.toLowerCase().includes(q));
  }, [pricing, provider, query]);

  const change = (model: string, field: Field, value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num < 0) return;
    setPricing((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [model]: { ...prev[provider]?.[model], [field]: num },
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pricing),
      });
      if (res.ok) {
        onSave?.();
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(`Failed to save pricing${body.error ? `: ${body.error}` : ""}`);
      }
    } catch (err) {
      console.error("Failed to save pricing:", err);
      setError("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/pricing", { method: "DELETE" });
      if (res.ok) setPricing(getDefaultPricing() as Pricing);
      else setError("Failed to reset pricing");
    } catch (err) {
      console.error("Failed to reset pricing:", err);
      setError("Failed to reset pricing");
    } finally {
      setResetting(false);
      setResetOpen(false);
    }
  };

  const busy = saving || resetting;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="xl"
        dismissible={!busy}
        title="Pricing"
        description="Rates in dollars per million tokens: 2.50 means $2.50 per 1M tokens."
        footer={
          <>
            <Button
              variant="danger"
              icon="restart_alt"
              onClick={() => setResetOpen(true)}
              disabled={busy || loading}
              className="md:mr-auto"
            >
              Reset to defaults
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="save"
              onClick={save}
              loading={saving}
              disabled={busy || loading}
            >
              Save changes
            </Button>
          </>
        }
      >
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : providers.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-text-muted">No pricing data available</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                aria-label="Provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="sm:w-48"
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p} ({Object.keys(pricing[p]).length})
                  </option>
                ))}
              </Select>
              <SearchInput
                aria-label="Filter models"
                placeholder="Filter models"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="sm:flex-1"
              />
            </div>
            {error && <Note tone="danger">{error}</Note>}
            {models.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
                No models match “{query}”
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {models.map((model) => (
                  <li key={model} className="space-y-2 px-3 py-3">
                    <div className="truncate font-mono text-xs" title={model}>
                      {model}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {FIELDS.map((f) => (
                        <label key={f.key} className="block">
                          <span className="mb-1 block text-[11px] text-text-muted">{f.label}</span>
                          <Input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            value={pricing[provider]?.[model]?.[f.key] || 0}
                            onChange={(e) => change(model, f.key, e.target.value)}
                            className="h-8 px-2 text-right tabular-nums"
                          />
                        </label>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={reset}
        loading={resetting}
        title="Reset pricing?"
        message="All rates go back to the defaults. This can't be undone."
        confirmText="Reset"
      />
    </>
  );
}
