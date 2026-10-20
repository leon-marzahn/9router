"use client";

import { Eyebrow, Icon, Panel, Tag } from "@/ui";
import { KIND, RECIPES, compact, kindOf, timeAgo, type Pipeline } from "./steps";
import type { PipelinesApi } from "./usePipelines";

type Row = { icon: string; source: string; value: string; mono?: boolean; pipeline: Pipeline };

/** "What runs, for whom" plus recipes to start from. */
export function Overview({
  api,
  onOpen,
  onCreate,
}: {
  api: PipelinesApi;
  onOpen: (name: string) => void;
  onCreate: (template: Pipeline) => void;
}) {
  const list = api.pipelines ?? [];
  const keyName = (id: string) => api.keys.find((k) => k.id === id)?.name ?? "Deleted key";
  const rows: Row[] = list.flatMap((p) => [
    ...(p.attach?.keys ?? []).map((id) => ({
      icon: "key",
      source: "API key",
      value: keyName(id),
      pipeline: p,
    })),
    ...(p.attach?.combos ?? []).map((c) => ({
      icon: "layers",
      source: "Combo",
      value: c,
      pipeline: p,
    })),
    {
      icon: "http",
      source: "Header",
      value: `X-Regent-Pipeline: ${p.name}`,
      mono: true,
      pipeline: p,
    },
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header>
        <h1 className="text-2xl">Request Pipelines</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-text-muted">
          Clean up requests before they reach a provider: strip blocks the model doesn’t need to see
          again, mask secrets, rewrite text. A pipeline runs for an API key or combo you attach it
          to, or when a client sends its name in a header. Requests that match nothing are sent
          unchanged.
        </p>
      </header>

      <section className="space-y-3">
        <Eyebrow>What runs, for whom</Eyebrow>
        {list.length ? (
          <Panel className="divide-y divide-border">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_16px_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-4 py-2 text-[11px] uppercase tracking-wider text-text-subtle md:grid">
              <span>When the request comes with</span>
              <span />
              <span>Run</span>
              <span>Since restart</span>
            </div>
            {rows.map((r) => {
              const u = api.usage[r.pipeline.name];
              return (
                <div
                  key={`${r.pipeline.name}:${r.source}:${r.value}`}
                  className="grid grid-cols-1 items-center gap-1 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_16px_minmax(0,1fr)_minmax(0,1fr)] md:gap-4"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[13px]">
                    <Icon name={r.icon} size={16} className="shrink-0 text-text-muted" />
                    <span className="shrink-0 text-text-muted">{r.source}</span>
                    <span className={r.mono ? "truncate font-mono text-[12px]" : "truncate"}>
                      {r.value}
                    </span>
                  </span>
                  <Icon
                    name="arrow_forward"
                    size={16}
                    className="hidden text-text-subtle md:block"
                  />
                  <button
                    type="button"
                    onClick={() => onOpen(r.pipeline.name)}
                    className="truncate text-left font-mono text-[13px] text-accent-text hover:underline max-md:min-h-10 max-md:min-w-10"
                  >
                    {r.pipeline.name}
                  </button>
                  <span className="text-[12px] text-text-muted">
                    {u
                      ? `${compact(u.requests)} req · −${compact(u.charsRemoved)} chars · ${timeAgo(u.lastUsed)}`
                      : "not used yet"}
                  </span>
                </div>
              );
            })}
            <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-text-muted">
              <Icon name="block" size={16} />
              Everything else is sent unchanged
            </div>
          </Panel>
        ) : (
          <p className="text-[13px] text-text-muted">
            No pipelines yet. Start from a recipe below.
          </p>
        )}
        <p className="text-[12px] text-text-subtle">
          Order: pipelines attached to the API key run first, then the combo’s, then the one named
          in the header. Each runs once. A header can add a pipeline but never skip an attached one.
        </p>
      </section>

      <section className="space-y-3">
        <Eyebrow>Start from a recipe</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2">
          {RECIPES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="text-left"
              onClick={() => onCreate(r.pipeline)}
            >
              <Panel interactive className="flex h-full gap-3 p-4">
                <Icon name={r.icon} size={22} className="mt-0.5 text-accent" />
                <div className="min-w-0 space-y-1.5">
                  <div className="text-[14px] font-medium">{r.title}</div>
                  <p className="text-[12px] text-text-muted">{r.blurb}</p>
                  <div className="flex flex-wrap gap-1">
                    {[...new Set(r.pipeline.rules.map(kindOf))].map((k) => (
                      <Tag key={k}>{KIND[k].label}</Tag>
                    ))}
                  </div>
                </div>
              </Panel>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
