"use client";

import { useState, type ReactNode } from "react";
import {
  Button,
  ConfirmDialog,
  Eyebrow,
  Icon,
  ProviderLogo,
  StatusLabel,
  Switch,
  Tag,
  cn,
} from "@/ui";
import Link from "next/link";
import { AddCustomEmbeddingModal } from "@/shared/components";
import { OAUTH_PROVIDERS } from "@/shared/constants/providers";
import ProviderManager from "../../providers/[id]/ProviderManager";
import { useNotificationStore } from "@/store/notificationStore";
import { kindById, providerInfo, type MediaEntry, type MediaKind } from "./model";
import { KindConfig } from "./KindConfig";
import { KIND_EXAMPLE_CONFIG } from "./examples/config";
import { EmbeddingExample } from "./examples/EmbeddingExample";
import { TtsExample } from "./examples/TtsExample";
import { SttExample } from "./examples/SttExample";
import { GenericExample } from "./examples/GenericExample";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStore as unknown as Notify).getState();

const Manager = ProviderManager as unknown as (p: {
  providerId: string;
  embedded: boolean;
  liveVersion: number;
  mediaKind: string;
}) => ReactNode;

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

/**
 * Selected media provider — same shape as the Providers detail: status and
 * quick actions, then accounts + this kind's models (the shared
 * ProviderManager), the kind's registry facts and a "Try it" panel.
 */
export function MediaDetail({
  p,
  kind,
  testing,
  liveVersion,
  onTest,
  onSetActive,
  onSwitchKind,
  onCustomChanged,
}: {
  p: MediaEntry;
  kind: MediaKind;
  testing: string | null;
  liveVersion: number;
  onTest: (id: string) => void;
  onSetActive: (ids: string[], active: boolean) => void;
  onSwitchKind: (kind: string) => void;
  /** A custom embedding node was edited or deleted. */
  onCustomChanged: (deleted: boolean) => void;
}) {
  const info = p.custom ? undefined : providerInfo(p.id);
  const kinds = p.custom ? [] : (info?.serviceKinds ?? []).filter((k) => kindById(k));
  const connected = p.stats.total > 0 || p.noAuth;
  const routing = !p.stats.allDisabled;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteCustom = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/provider-nodes/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify().success(`Deleted ${p.name}`);
      onCustomChanged(true);
    } catch (e) {
      notify().error(`Couldn’t delete ${p.name}: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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
            <span className="text-text-muted">{kind.label}</span>
            {p.custom && (
              <Tag>
                Custom
                {p.custom.prefix && <span className="font-mono">· {p.custom.prefix}</span>}
              </Tag>
            )}
            <span className="truncate font-mono text-text-subtle">{p.id}</span>
          </div>
        </div>
        {p.stats.total > 0 && (
          <div className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
            <span aria-hidden className="hidden sm:inline">
              Routing
            </span>
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

      {(kinds.length > 1 || (connected && !p.noAuth) || p.custom) && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
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
          {p.custom && (
            <>
              <Button icon="edit" onClick={() => setEditing(true)}>
                Edit endpoint
              </Button>
              <Button
                variant="danger"
                icon="delete"
                loading={deleting}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            </>
          )}
          {kinds.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
              <span className="text-[11px] text-text-subtle">Also</span>
              {kinds
                .filter((k) => k !== kind.id)
                .map((k) => {
                  const mk = kindById(k)!;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => onSwitchKind(k)}
                      className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-[11px] text-text-muted hover:bg-surface-2 hover:text-text"
                    >
                      <Icon name={mk.icon} size={14} />
                      {mk.short}
                    </button>
                  );
                })}
            </div>
          )}
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

      {info?.kindNotice?.[kind.id] && (
        <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-warning/12 px-4 py-3 text-xs leading-relaxed text-warning-text">
          <Icon name="warning" size={18} className="mt-px shrink-0" />
          <p className="min-w-0">{info.kindNotice[kind.id]}</p>
        </div>
      )}

      {/* Speech-to-text on an OAuth provider (Codex) reuses its chat sign-ins; an API key
          won't do. Other OAuth providers' media lanes keep their own accounts (00dd3dfc). */}
      {kind.id === "stt" && !p.custom && p.id in OAUTH_PROVIDERS && (
        <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-surface px-4 py-3 text-xs leading-relaxed ring-1 ring-border">
          <Icon name="link" size={18} className="mt-px shrink-0 text-text-muted" />
          <p className="min-w-0 text-text-muted">
            Uses the {p.name} accounts you signed in to under Providers; an API key can&rsquo;t
            stand in for them.{" "}
            <Link
              href={`/dashboard/providers?p=${encodeURIComponent(p.id)}`}
              className="font-medium text-accent-text underline-offset-2 hover:underline"
            >
              Manage {p.name} sign-ins
            </Link>
          </p>
        </div>
      )}

      {/* Accounts + this kind's models: the same management surface as Providers */}
      <div className="mt-10">
        <Manager providerId={p.id} embedded liveVersion={liveVersion} mediaKind={kind.id} />
      </div>

      <div className="mt-8 space-y-8">
        {info && <KindConfig title={`${kind.short} config`} config={kindConfigOf(info, kind.id)} />}
        <Example p={p} kind={kind.id} />
      </div>

      {p.custom && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={`Delete ${p.name}?`}
          message="Requests for this embedding prefix stop working."
          confirmText="Delete"
          onConfirm={() => void deleteCustom()}
        />
      )}
      {p.custom && (
        <AddCustomEmbeddingModal
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
        customAlias={p.custom ? p.custom.prefix || "" : undefined}
      />
    );
  if (p.custom) return null;
  if (kind === "tts") return <TtsExample key={key} providerId={p.id} />;
  if (kind === "stt") return <SttExample key={key} providerId={p.id} />;
  if (KIND_EXAMPLE_CONFIG[kind])
    return <GenericExample key={key} providerId={p.id} kind={kind} connections={p.connections} />;
  return null;
}
