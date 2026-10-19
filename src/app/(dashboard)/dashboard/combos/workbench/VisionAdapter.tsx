"use client";

import { useEffect, useState } from "react";
import { Button, IconButton, Panel, Switch } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { notify } from "./useCombos";

const Picker = ModelSelectModal as unknown as React.ComponentType<Record<string, unknown>>;
const FREE_DEFAULT = "oc/mimo-v2.6-flash-free";

interface Cap {
  enabled: boolean;
  roundRobin: boolean;
  models: string[];
}
type Adapter = Record<string, Cap | Array<{ model: string; enabled?: boolean }>>;

// Older settings stored a list of {model, enabled}; normalise to the current shape.
const norm = (v: Adapter[string] | undefined): Cap =>
  Array.isArray(v)
    ? {
        enabled: v.some((x) => x.enabled !== false),
        roundRobin: false,
        models: v.map((x) => x.model),
      }
    : { enabled: !!v?.enabled, roundRobin: !!v?.roundRobin, models: v?.models ?? [] };

/**
 * Vision fallback: when a request has images and the chosen model can't see,
 * these models describe the images first. Stored in settings.capacityAdapter.vision.
 */
export function VisionAdapter() {
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/settings", { cache: "no-store" })
        .then((r) => r.json())
        .then((s) => setAdapter(s.capacityAdapter || {}))
        .catch(() => setAdapter({}));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const cap = norm(adapter?.vision);
  const save = async (next: Cap) => {
    const models = next.models.length ? next.models : [FREE_DEFAULT];
    const all = { ...(adapter || {}), vision: { ...next, models } };
    setAdapter(all);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capacityAdapter: all }),
    }).catch(() => null);
    if (!res?.ok) notify().error("Couldn't save the vision fallback");
  };
  const move = (i: number, d: number) => {
    const m = [...cap.models];
    [m[i], m[i + d]] = [m[i + d], m[i]];
    void save({ ...cap, models: m });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header>
        <h1 className="font-display text-3xl">Vision fallback</h1>
        <p className="mt-1 text-[13px] text-text-muted">
          When a request has images but the model it goes to can&rsquo;t see, one of these models
          looks at the images first. Applies to every model and combo.
        </p>
      </header>
      <Panel className="divide-y divide-border px-4">
        <div className="flex items-center justify-between gap-3 py-4">
          <div className="text-[13px] font-medium">On</div>
          <Switch
            checked={cap.enabled}
            disabled={!adapter}
            onChange={(v) => void save({ ...cap, enabled: v })}
            label="Vision fallback"
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-4">
          <div>
            <div className="text-[13px] font-medium">Take turns</div>
            <div className="text-[12px] text-text-muted">
              Spread image requests across the models instead of always using the first.
            </div>
          </div>
          <Switch
            checked={cap.roundRobin}
            disabled={!adapter}
            onChange={(v) => void save({ ...cap, roundRobin: v })}
            label="Take turns"
          />
        </div>
      </Panel>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-medium">Models</h2>
          <Button size="sm" icon="add" onClick={() => setPicking(true)}>
            Add model
          </Button>
        </div>
        <Panel className="divide-y divide-border">
          {cap.models.map((m, i) => (
            <div key={m} className="flex items-center gap-2 px-3 py-2">
              <span className="w-4 text-center text-[12px] tabular-nums text-text-subtle">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m}</span>
              {m === FREE_DEFAULT && (
                <span className="text-[11px] text-text-subtle">free default</span>
              )}
              <IconButton
                icon="arrow_upward"
                label="Move up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              />
              <IconButton
                icon="arrow_downward"
                label="Move down"
                disabled={i === cap.models.length - 1}
                onClick={() => move(i, 1)}
              />
              <IconButton
                icon="close"
                label="Remove"
                onClick={() => void save({ ...cap, models: cap.models.filter((x) => x !== m) })}
              />
            </div>
          ))}
        </Panel>
      </section>
      {picking && (
        <Picker
          isOpen
          onClose={() => setPicking(false)}
          title="Vision models"
          capFilter="vision"
          closeOnSelect={false}
          addedModelValues={cap.models}
          onSelect={(x: { value?: string }) =>
            x?.value &&
            !cap.models.includes(x.value) &&
            void save({ ...cap, models: [...cap.models, x.value] })
          }
          onDeselect={(x: { value?: string }) =>
            void save({ ...cap, models: cap.models.filter((y) => y !== x?.value) })
          }
        />
      )}
    </div>
  );
}
