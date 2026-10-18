"use client";

import { Button, Panel, ProviderLogo, SectionTitle, StatGrid, StatusLabel, Tag, cn } from "@/ui";
import { KIND_LABEL, type ProviderEntry } from "../model";
import type { Totals } from "./totals";

/** Detail pane when nothing is selected: headline, KPIs, problems, then everything live. */
export function ProviderOverview({
  totals,
  attention,
  live,
  testing,
  onTest,
  onSelect,
}: {
  totals: Totals;
  attention: ProviderEntry[];
  live: ProviderEntry[];
  testing: string | null;
  onTest: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="mx-auto max-w-4xl px-6 pb-10 pt-10 lg:px-8">
      <h1 className="font-display text-4xl tracking-tight">Routing overview</h1>
      <p className="mt-2 text-text-muted">
        <b className="text-text">{totals.live} providers</b> and{" "}
        <b className="text-text">{totals.healthy} healthy accounts</b> in rotation
        {totals.failing ? (
          <>
            {" "}
            · <span className="text-danger-text">{totals.failing} need attention</span>
          </>
        ) : (
          " · all clear"
        )}
        .
      </p>

      <StatGrid
        className="mt-8"
        items={[
          { label: "Live providers", value: totals.live, sub: `of ${totals.available} available` },
          { label: "Accounts", value: totals.accounts, sub: `${totals.healthy} healthy` },
          {
            label: "Failing",
            value: totals.failing,
            tone: "danger",
            sub: totals.failing ? "see below" : "nothing to fix",
          },
          { label: "Free, no-auth", value: totals.free, sub: "always ready" },
        ]}
      />

      {attention.length > 0 && (
        <section className="mt-10">
          <SectionTitle icon="error" title="Needs attention" tone="danger" />
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {attention.map((p) => (
              <div
                key={p.id}
                className="flex gap-4 rounded-2xl border border-danger-border bg-danger-soft p-4"
              >
                <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface shadow-soft">
                  <ProviderLogo
                    providerId={p.id}
                    src={p.iconSrc}
                    name={p.name}
                    color={p.color}
                    fallbackText={p.textIcon}
                    size={26}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{p.name}</span>
                    <Tag tone="solid-danger" mono>
                      {p.stats.errorCode || "ERR"}
                    </Tag>
                    {p.stats.errorTime && (
                      <span className="shrink-0 text-xs text-text-muted">{p.stats.errorTime}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[13px] text-text-muted">
                    {p.stats.error} of {p.stats.total} accounts failing
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="inverse"
                      size="sm"
                      loading={testing === p.id}
                      onClick={() => onTest(p.id)}
                    >
                      Re-test
                    </Button>
                    <Button size="sm" onClick={() => onSelect(p.id)}>
                      Inspect accounts
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-10">
        <SectionTitle icon="bolt" title="Live" count={live.length} />
        {live.length === 0 ? (
          <p className="mt-3 text-text-muted">
            Nothing is routing yet. Pick a provider from the list to connect it.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((p) => {
              const total = Math.max(p.stats.total, 1);
              return (
                <Panel
                  key={p.id}
                  interactive
                  className={cn("cursor-pointer p-4", p.status === "paused" && "opacity-55")}
                  onClick={() => onSelect(p.id)}
                >
                  <div className="flex items-center gap-3">
                    <ProviderLogo
                      providerId={p.id}
                      src={p.iconSrc}
                      name={p.name}
                      color={p.color}
                      fallbackText={p.textIcon}
                      size={24}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{p.name}</div>
                      <StatusLabel status={p.status} />
                    </div>
                    {!p.noAuth && (
                      <span className="text-xs tabular-nums text-text-muted">
                        {p.stats.connected}/{p.stats.total}
                      </span>
                    )}
                  </div>
                  {p.noAuth ? (
                    <div className="mt-3 text-xs text-text-muted">
                      {KIND_LABEL[p.kind]} · no account needed
                    </div>
                  ) : (
                    <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="bg-success transition-[width] duration-500"
                        style={{ width: `${(p.stats.connected / total) * 100}%` }}
                      />
                      <div
                        className="bg-danger transition-[width] duration-500"
                        style={{ width: `${(p.stats.error / total) * 100}%` }}
                      />
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
