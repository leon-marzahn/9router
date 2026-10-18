// Media provider list model: providers that serve one media kind (speech,
// embeddings, images, web search…), annotated with the same status vocabulary
// as the Providers workbench.

import {
  AI_PROVIDERS,
  MEDIA_PROVIDER_KINDS,
  getProvidersByKind,
} from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { STATUS_ORDER, type Status } from "@/ui/status";
import {
  statsFor,
  statusFor,
  type Connection,
  type ProviderNode,
  type ProviderStats,
} from "../../providers/model";

export interface MediaKind {
  id: string;
  label: string;
  /** Short label for the kind switch. */
  short: string;
  icon: string;
  endpoint: { method: string; path: string };
  /** Kinds whose routing can go through a combo. */
  combos: boolean;
}

// Display order and short names; everything else comes from MEDIA_PROVIDER_KINDS.
const ORDER: [id: string, short: string][] = [
  ["tts", "Speech"],
  ["stt", "Transcription"],
  ["embedding", "Embeddings"],
  ["image", "Images"],
  ["imageToText", "Vision"],
  ["video", "Video"],
  ["music", "Music"],
  ["webSearch", "Web search"],
  ["webFetch", "Web fetch"],
  ["systemone", "System One"],
];
const COMBO_KINDS = new Set(["webSearch", "webFetch"]);

type RawKind = { id: string; label: string; icon: string; endpoint: MediaKind["endpoint"] };
const raw = MEDIA_PROVIDER_KINDS as RawKind[];

/** Kinds that at least one provider serves, in display order. */
export const MEDIA_KINDS: MediaKind[] = ORDER.flatMap(([id, short]) => {
  const k = raw.find((r) => r.id === id);
  if (!k || getProvidersByKind(id).length === 0) return [];
  return [{ ...k, short, combos: COMBO_KINDS.has(id) }];
});
export const DEFAULT_KIND = MEDIA_KINDS[0]?.id ?? "tts";
export const kindById = (id: string | null) => MEDIA_KINDS.find((k) => k.id === id);

export interface ProviderInfo {
  id: string;
  name: string;
  color?: string;
  textIcon?: string;
  noAuth?: boolean;
  deprecated?: boolean;
  serviceKinds?: string[];
  notice?: { text?: string; apiKeyUrl?: string };
  kindNotice?: Record<string, string>;
  searchConfig?: unknown;
  fetchConfig?: unknown;
  ttsConfig?: { models?: { id: string }[] } & Record<string, unknown>;
  sttConfig?: unknown;
  embeddingConfig?: unknown;
  systemoneConfig?: unknown;
  searchViaChat?: { defaultModel?: string; pricingUrl?: string; freeTier?: unknown };
}
export const providerInfo = (id: string) =>
  (AI_PROVIDERS as Record<string, ProviderInfo>)[id] as ProviderInfo | undefined;

export interface MediaEntry {
  id: string;
  name: string;
  color?: string;
  textIcon?: string;
  iconSrc: string | null;
  noAuth: boolean;
  /** Custom embedding node (user-defined OpenAI-compatible embeddings endpoint). */
  custom?: ProviderNode;
  connections: Connection[];
  stats: ProviderStats;
  status: Status;
}

/** Providers for one kind, built-in first by registry priority, then custom nodes; problems first. */
export function buildMediaProviders(
  kind: string,
  connections: Connection[],
  nodes: ProviderNode[],
): MediaEntry[] {
  const entry = (
    id: string,
    info: Pick<ProviderInfo, "name" | "color" | "textIcon" | "noAuth">,
    extra: Partial<MediaEntry> = {},
  ): MediaEntry => {
    const conns = connections.filter((c) => c.provider === id);
    const stats = statsFor(conns);
    const noAuth = !!info.noAuth;
    return {
      id,
      name: info.name,
      color: info.color,
      textIcon: info.textIcon,
      iconSrc: getProviderIconSrc(id),
      noAuth,
      connections: conns,
      stats,
      status: statusFor(noAuth, stats),
      ...extra,
    };
  };
  const builtIn = (getProvidersByKind(kind) as ProviderInfo[]).map((p) => entry(p.id, p));
  const custom =
    kind === "embedding"
      ? nodes
          .filter((n) => n.type === "custom-embedding")
          .map((n) =>
            entry(
              n.id,
              { name: n.name || "Custom Embedding", color: "#6366F1", textIcon: "CE" },
              { iconSrc: null, custom: n },
            ),
          )
      : [];
  // Stable sort keeps registry priority inside each status.
  return [...builtIn, ...custom].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

export const isLive = (p: MediaEntry) => p.stats.total > 0 || p.noAuth;

export const versionOf = (p: MediaEntry) =>
  `${p.status}:${p.stats.connected}/${p.stats.total}:${p.stats.errorCode ?? ""}`;

export interface MediaCombo {
  id: string;
  name: string;
  kind: string | null;
  models: string[];
}

/** "provider/model" or "provider" → parts. */
export function parseComboEntry(entry: unknown): { providerId: string; model: string } {
  if (typeof entry !== "string") return { providerId: "", model: "" };
  const i = entry.indexOf("/");
  return i < 0
    ? { providerId: entry, model: "" }
    : { providerId: entry.slice(0, i), model: entry.slice(i + 1) };
}

export { mediaHref } from "./href";
