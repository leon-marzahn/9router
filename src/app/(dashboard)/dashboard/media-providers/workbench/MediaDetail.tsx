"use client";

import { useState, type ReactNode } from "react";
import { Button, Icon, ProviderLogo, StatusLabel, Switch, Tag, cn } from "@/ui";
import { AddCustomEmbeddingModal, NoAuthProxyCard, ProviderInfoCard } from "@/shared/components";
import ConnectionsCard from "../../providers/components/ConnectionsCard";
import ModelsCard from "../../providers/components/ModelsCard";
import { useNotificationStore } from "@/store/notificationStore";
import { kindById, providerInfo, type MediaEntry, type MediaKind } from "./model";
import { KIND_EXAMPLE_CONFIG } from "./examples/config";
import { EmbeddingExample } from "./examples/EmbeddingExample";
import { TtsExample } from "./examples/TtsExample";
import { SttExample } from "./examples/SttExample";
import { GenericExample } from "./examples/GenericExample";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStore as unknown as Notify).getState();

// The legacy cards use these props; they're plain JS.
const Legacy = {
  AddCustomEmbeddingModal: AddCustomEmbeddingModal as unknown as (p: {
    isOpen: boolean;
    node: unknown;
    onClose: () => void;
    onSaved: (n: unknown) => void;
  }) => ReactNode,
  NoAuthProxyCard: NoAuthProxyCard as unknown as (p: { providerId: string }) => ReactNode,
  ProviderInfoCard: ProviderInfoCard as unknown as (p: {
    config: unknown;
    provider: unknown;
    title: string;
  }) => ReactNode,
  ConnectionsCard: ConnectionsCard as unknown as (p: {
    providerId: string;
    isOAuth: boolean;
  }) => ReactNode,
  ModelsCard: ModelsCard as unknown as (p: {
    providerId: string;
    kindFilter: string;
    providerAliasOverride?: string;
  }) => ReactNode,
};

// Kinds where the provider itself is the model (no model list to manage).
const NO_MODELS = new Set(["tts", "webSearch", "webFetch"]);

function kindConfigOf(info: NonNullable<ReturnType<typeof providerInfo>>, kind: string): unknown {
  switch (kind) {
    case "webFetch":
      return info.fetchConfig;
    case "tts":
      return info.ttsConfig;
    case "stt":
      return info.sttConfig;
    case "embedding":
      return info.embeddingConfig;
    case "systemone":
      return info.systemoneConfig;
    default:
      return (
        info.searchConfig ||
        (info.searchViaChat && {
          mode: "chat-completions",
          defaultModel: info.searchViaChat.defaultModel,
          pricingUrl: info.searchViaChat.pricingUrl,
          freeTier: info.searchViaChat.freeTier,
        })
      );
  }
}

/** Selected media provider: status, accounts, models, config and a "Try it" panel. */
export function MediaDetail({
  p,
  kind,
  onSetActive,
  onSwitchKind,
  onCustomChanged,
}: {
  p: MediaEntry;
  kind: MediaKind;
  onSetActive: (ids: string[], active: boolean) => void;
  onSwitchKind: (kind: string) => void;
  /** A custom embedding node was edited (null = deleted). */
  onCustomChanged: (deleted: boolean) => void;
}) {
  const info = p.custom ? undefined : providerInfo(p.id);
  const kinds = p.custom ? ["embedding"] : (info?.serviceKinds ?? []);
  const routing = !p.stats.allDisabled;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const config = info ? kindConfigOf(info, kind.id) : undefined;

  const deleteCustom = async () => {
    if (!confirm(`Delete the custom embedding "${p.name}"?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/provider-nodes/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify().success(`Deleted ${p.name}`);
      onCustomChanged(true);
    } catch (e) {
      notify().error(`Couldn't delete ${p.name}: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="flex flex-wrap items-start gap-4">
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
            {p.custom && (
              <Tag>
                Custom{p.custom.prefix ? ` · ` : ""}
                {p.custom.prefix && <span className="font-mono">{p.custom.prefix}</span>}
              </Tag>
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

      {/* Other media kinds this provider serves */}
      {kinds.length > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-text-subtle">Also serves</span>
          {kinds.map((k) => {
            const mk = kindById(k);
            if (!mk) return null;
            const current = k === kind.id;
            return (
              <button
                key={k}
                type="button"
                disabled={current}
                onClick={() => onSwitchKind(k)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px]",
                  current
                    ? "border-accent-ring bg-accent-soft text-accent-text"
                    : "border-border text-text-muted hover:text-text",
                )}
              >
                <Icon name={mk.icon} size={13} />
                {mk.short}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {info?.notice?.apiKeyUrl && (
          <a
            href={info.notice.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 text-xs hover:bg-surface-2 dark:border-border"
          >
            Get API key <Icon name="open_in_new" size={16} />
          </a>
        )}
        {p.custom && (
          <>
            <Button icon="edit" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="danger" icon="delete" loading={deleting} onClick={deleteCustom}>
              Delete
            </Button>
          </>
        )}
      </div>

      {info?.kindNotice?.[kind.id] && (
        <Notice tone="warning" icon="warning">
          {info.kindNotice[kind.id]}
        </Notice>
      )}
      {info?.notice?.text && !info.deprecated && (
        <Notice tone="info" icon="info">
          {info.notice.text}
        </Notice>
      )}

      {/* Accounts, models and config — the shared management cards, inline */}
      <div className="mt-8 space-y-6">
        {info?.noAuth ? (
          <Legacy.NoAuthProxyCard providerId={p.id} />
        ) : (
          <Legacy.ConnectionsCard providerId={p.id} isOAuth={false} />
        )}
        {!NO_MODELS.has(kind.id) && (
          <Legacy.ModelsCard
            providerId={p.id}
            kindFilter={kind.id}
            providerAliasOverride={p.custom?.prefix}
          />
        )}
        {!!config && (
          <Legacy.ProviderInfoCard config={config} provider={info} title={`${kind.label} config`} />
        )}
        <Example p={p} kind={kind.id} />
      </div>

      {p.custom && (
        <Legacy.AddCustomEmbeddingModal
          isOpen={editing}
          node={p.custom}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onCustomChanged(false);
          }}
        />
      )}
    </div>
  );
}

function Example({ p, kind }: { p: MediaEntry; kind: string }) {
  // Keyed by provider + kind so form state never leaks between providers.
  const key = `${p.id}:${kind}`;
  if (kind === "embedding")
    return (
      <EmbeddingExample
        key={key}
        providerId={p.id}
        customAlias={p.custom?.prefix ?? (p.custom ? "" : undefined)}
      />
    );
  if (p.custom) return null;
  if (kind === "tts") return <TtsExample key={key} providerId={p.id} />;
  if (kind === "stt") return <SttExample key={key} providerId={p.id} />;
  if (KIND_EXAMPLE_CONFIG[kind])
    return <GenericExample key={key} providerId={p.id} kind={kind} connections={p.connections} />;
  return null;
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "info";
  icon: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-2.5 rounded-xl px-4 py-3 text-xs leading-relaxed",
        tone === "warning" ? "bg-warning/12 text-warning-text" : "bg-info/12 text-info-text",
      )}
    >
      <Icon name={icon} size={18} className="mt-px shrink-0" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
