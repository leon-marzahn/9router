"use client";

import {
  Button,
  EmptyState,
  Icon,
  Panel,
  ProviderLogo,
  StatGrid,
  StatusLabel,
  Tag,
  needsAttention,
} from "@/ui";
import { isLive, type MediaCombo, type MediaEntry, type MediaKind } from "./model";

/** Nothing selected: how this media kind is set up, problems first. */
export function MediaOverview({
  kind,
  providers,
  combos,
  onSelect,
  onSelectCombo,
  onCreateCombo,
}: {
  kind: MediaKind;
  providers: MediaEntry[];
  combos: MediaCombo[];
  onSelect: (id: string) => void;
  onSelectCombo: (id: string) => void;
  onCreateCombo?: () => void;
}) {
  const failing = providers.filter((p) => needsAttention(p.status));
  const live = providers.filter((p) => isLive(p) && !needsAttention(p.status));
  const accounts = providers.reduce((n, p) => n + p.stats.total, 0);
  const free = providers.filter((p) => p.noAuth).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <Icon name={kind.icon} size={16} />
        <Tag mono>{kind.endpoint.method}</Tag>
        <span className="min-w-0 truncate font-mono">{kind.endpoint.path}</span>
      </div>
      <h1 className="mt-2 font-display text-3xl tracking-tight">{kind.label}</h1>
      <p className="mt-2 text-text-muted">
        {live.length > 0 ? (
          <>
            <b className="font-semibold text-text">
              {live.length} provider{live.length === 1 ? "" : "s"}
            </b>{" "}
            ready to serve {kind.label.toLowerCase()} requests
            {failing.length > 0 && (
              <>
                {" "}
                · <span className="text-danger-text">{failing.length} need attention</span>
              </>
            )}
            .
          </>
        ) : (
          <>Nothing is connected yet. Pick a provider on the left and add a key to start.</>
        )}
      </p>

      <StatGrid
        className="mt-6"
        items={[
          { label: "Healthy", value: live.length, sub: `of ${providers.length} providers` },
          { label: "Accounts", value: accounts },
          { label: "Failing", value: failing.length, tone: "danger" },
          kind.combos
            ? { label: "Combos", value: combos.length }
            : { label: "Free, no key", value: free },
        ]}
      />

      {failing.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-danger-text">Needs attention</h2>
          <div className="space-y-2">
            {failing.map((p) => (
              <Panel
                key={p.id}
                className="flex items-center gap-3 border-danger-border bg-danger-soft p-3"
              >
                <ProviderLogo
                  providerId={p.id}
                  src={p.iconSrc}
                  name={p.name}
                  color={p.color}
                  fallbackText={p.textIcon}
                  size={24}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{p.name}</div>
                  <div className="truncate text-[11px] text-danger-text">
                    {p.stats.lastError || `${p.stats.error} failing account(s)`}
                  </div>
                </div>
                <Button onClick={() => onSelect(p.id)} trailingIcon="arrow_forward">
                  Inspect
                </Button>
              </Panel>
            ))}
          </div>
        </section>
      )}

      {kind.combos && (
        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Combos</h2>
            <span className="text-xs text-text-subtle">{combos.length}</span>
            {onCreateCombo && (
              <Button className="ml-auto" icon="add" onClick={onCreateCombo}>
                New combo
              </Button>
            )}
          </div>
          {combos.length === 0 ? (
            <EmptyState icon="layers">
              A combo tries several {kind.short.toLowerCase()} providers in order (or rotates them)
              under one model name.
            </EmptyState>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {combos.map((c) => (
                <Panel
                  key={c.id}
                  interactive
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectCombo(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && onSelectCombo(c.id)}
                  className="flex cursor-pointer items-center gap-3 p-3"
                >
                  <Icon name="layers" size={20} className="text-accent" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{c.name}</span>
                  <span className="text-[11px] text-text-muted">
                    {c.models.length} provider{c.models.length === 1 ? "" : "s"}
                  </span>
                </Panel>
              ))}
            </div>
          )}
        </section>
      )}

      {live.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold">Healthy</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {live.map((p) => (
              <Panel
                key={p.id}
                interactive
                role="button"
                tabIndex={0}
                onClick={() => onSelect(p.id)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(p.id)}
                className="flex cursor-pointer items-center gap-3 p-3"
              >
                <ProviderLogo
                  providerId={p.id}
                  src={p.iconSrc}
                  name={p.name}
                  color={p.color}
                  fallbackText={p.textIcon}
                  size={24}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{p.name}</div>
                  <StatusLabel status={p.status} className="text-[11px]" />
                </div>
                {p.stats.total > 0 && (
                  <span className="text-[11px] tabular-nums text-text-muted">
                    {p.stats.connected}/{p.stats.total}
                  </span>
                )}
              </Panel>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
