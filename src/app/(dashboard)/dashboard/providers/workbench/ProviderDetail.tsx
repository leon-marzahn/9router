"use client";

import { Button, Eyebrow, ProviderLogo, StatusLabel, Switch, Tag, cn } from "@/ui";
import { KIND_LABEL, cooldownsOf, type ProviderEntry } from "../model";
import { Cooldowns } from "./Cooldowns";
import ProviderManager from "../[id]/ProviderManager";

/** Selected provider: status, quick actions, then the full account/model management inline. */
export function ProviderDetail({
  p,
  testing,
  onTest,
  onSetActive,
  onClearCooldown,
  liveVersion,
}: {
  p: ProviderEntry;
  testing: string | null;
  onTest: (id: string) => void;
  onSetActive: (ids: string[], active: boolean) => void;
  onClearCooldown: (provider: string, model: string) => Promise<void>;
  liveVersion: number;
}) {
  const connected = p.stats.total > 0 || p.noAuth;
  const routing = !p.stats.allDisabled;

  return (
    <div className="mx-auto max-w-3xl px-6 pb-10 pt-8 lg:px-8">
      <div className="flex items-start gap-4">
        <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface shadow-soft ring-1 ring-border">
          <ProviderLogo
            providerId={p.id}
            src={p.iconSrc}
            name={p.name}
            color={p.color}
            fallbackText={p.textIcon}
            size={34}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-3xl tracking-tight">{p.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <StatusLabel status={p.status} />
            <span className="text-text-muted">{KIND_LABEL[p.kind]}</span>
            {p.apiType && (
              <Tag>{p.apiType === "responses" ? "Responses API" : "Chat Completions"}</Tag>
            )}
            <span className="truncate font-mono text-text-subtle">{p.id}</span>
          </div>
        </div>
        {p.stats.total > 0 && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
            <span aria-hidden>Routing</span>
            <Switch
              checked={routing}
              label={routing ? `Pause ${p.name}` : `Resume ${p.name}`}
              onChange={(on) =>
                onSetActive(
                  p.connections.map((c) => c.id),
                  on,
                )
              }
            />
          </div>
        )}
      </div>

      {connected && !p.noAuth && (
        <div className="mt-6 flex flex-wrap gap-2">
          {
            <Button
              variant="primary"
              icon="play_arrow"
              loading={testing === p.id}
              disabled={!!testing && testing !== p.id}
              onClick={() => onTest(p.id)}
            >
              Test accounts
            </Button>
          }
        </div>
      )}

      {connected && !p.noAuth && (
        <div className="mt-8 grid grid-cols-3 gap-3">
          {(
            [
              ["Accounts", p.stats.total],
              ["Healthy", p.stats.connected],
              ["Failing", p.stats.error],
            ] as const
          ).map(([l, v]) => (
            <div key={l} className="rounded-xl border border-border bg-surface p-4">
              <Eyebrow>{l}</Eyebrow>
              <div
                className={cn(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  l === "Failing" && v > 0 && "text-danger-text",
                )}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      )}

      <Cooldowns cooldowns={cooldownsOf(p)} onClear={(model) => onClearCooldown(p.id, model)} />

      {/* Accounts, overrides and models — the full management surface, inline */}
      <div className="mt-10">
        <ProviderManager providerId={p.id} embedded liveVersion={liveVersion} />
      </div>
    </div>
  );
}
