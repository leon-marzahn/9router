"use client";

import Link from "next/link";
import {
  Button,
  EmptyState,
  Eyebrow,
  IconButton,
  ProviderLogo,
  StatusDot,
  StatusLabel,
  Switch,
  Tag,
  cn,
} from "@/ui";
import {
  KIND_LABEL,
  connectionLabel,
  cooldownsOf,
  errorTag,
  isFailing,
  type ProviderEntry,
} from "../model";
import { Cooldowns } from "./Cooldowns";

/** Selected provider: status, actions, and its accounts managed inline. */
export function ProviderDetail({
  p,
  testing,
  onTest,
  onTestConnection,
  onSetActive,
  onClearCooldown,
}: {
  p: ProviderEntry;
  testing: string | null;
  onTest: (id: string) => void;
  onTestConnection: (id: string) => void;
  onSetActive: (ids: string[], active: boolean) => void;
  onClearCooldown: (provider: string, model: string) => Promise<void>;
}) {
  const href = `/dashboard/providers/${encodeURIComponent(p.id)}`;
  const connected = p.stats.total > 0 || p.noAuth;
  const routing = !p.stats.allDisabled;

  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-8 lg:px-8">
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

      <div className="mt-6 flex flex-wrap gap-2">
        {connected && !p.noAuth && (
          <Button
            variant="primary"
            icon="play_arrow"
            loading={testing === p.id}
            disabled={!!testing && testing !== p.id}
            onClick={() => onTest(p.id)}
          >
            Test accounts
          </Button>
        )}
        {!p.noAuth && (
          <Link href={href}>
            <Button
              variant={connected ? "secondary" : "primary"}
              icon={connected ? "person_add" : "link"}
            >
              {connected
                ? `Add ${p.kind === "oauth" ? "account" : "key"}`
                : p.kind === "oauth"
                  ? "Sign in to connect"
                  : "Add API key"}
            </Button>
          </Link>
        )}
        <Link href={href}>
          <Button variant="ghost" trailingIcon="arrow_forward">
            Models & settings
          </Button>
        </Link>
      </div>

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

      <Eyebrow className="mb-2 mt-10">Accounts</Eyebrow>
      {p.noAuth ? (
        <EmptyState icon="verified">
          No authentication needed. This provider is routed automatically.
        </EmptyState>
      ) : p.connections.length === 0 ? (
        <EmptyState icon="link_off">
          Not connected yet. {p.kind === "oauth" ? "Sign in with an account" : "Add an API key"} to
          start routing to {p.name}.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {p.connections.map((c) => {
            const active = c.isActive !== false;
            const bad = isFailing(c);
            return (
              <div
                key={c.id}
                className={cn("flex items-center gap-3 px-4 py-3", !active && "opacity-50")}
              >
                <StatusDot status={!active ? "paused" : bad ? "error" : "ok"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{connectionLabel(c)}</div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
                    <span className="shrink-0">
                      {c.authType}
                      {c.priority != null && ` · priority ${c.priority}`}
                    </span>
                    {bad && (
                      <Tag tone="danger" mono>
                        {errorTag(c)}
                      </Tag>
                    )}
                    {bad && c.lastError && (
                      <span className="truncate text-danger-text">
                        {String(c.lastError).slice(0, 120)}
                      </span>
                    )}
                  </div>
                </div>
                <IconButton
                  icon="play_arrow"
                  label={`Test ${connectionLabel(c)}`}
                  onClick={() => onTestConnection(c.id)}
                />
                <Switch
                  checked={active}
                  label={active ? "Disable account" : "Enable account"}
                  onChange={(on) => onSetActive([c.id], on)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
