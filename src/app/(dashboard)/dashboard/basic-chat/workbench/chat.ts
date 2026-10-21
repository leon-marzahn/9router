import { getModelsByProviderId } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

export const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  draft: "basic-chat.draft",
  recentModels: "basic-chat.recentModels",
};

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size?: number;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  attachments?: Attachment[];
  createdAt: string;
  status?: "streaming" | "done" | "error";
}

export interface ChatSession {
  id: string;
  title: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatModel {
  id: string;
  requestModel: string;
  name: string;
  providerId: string;
  providerName: string;
  source: "static" | "live";
}

export interface ProviderGroup {
  providerId: string;
  providerName: string;
  providerType: string;
  connections: Connection[];
  models: ChatModel[];
}

export interface Connection {
  id: string;
  provider?: string;
  name?: string;
  isActive?: boolean;
  providerSpecificData?: { nodeName?: string };
}

export function createId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function safeParse<T>(value: string | null, fallback: T): T {
  try {
    return value == null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

export function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const v = value as { message?: unknown; error?: unknown };
    if (typeof v.message === "string") return v.message;
    if (typeof v.error === "string") return v.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function humanize(value = ""): string {
  return (
    String(value)
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim() || "Unknown"
  );
}

export function formatRelativeTime(value?: string): string {
  if (!value) return "Now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

export function makeSessionTitle(text: unknown = ""): string {
  const normalized = textValue(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 52 ? `${normalized.slice(0, 52).trimEnd()}…` : normalized;
}

export function buildUserContent(message: ChatMessage) {
  const text = textValue(message.content).trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length === 0) return text;

  const content: (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  )[] = [];
  if (text) content.push({ type: "text", text });
  for (const attachment of attachments) {
    if (attachment?.dataUrl)
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
  }
  return content.length > 0 ? content : text;
}

interface Chunk {
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
  output_text?: unknown;
  text?: unknown;
}

export function readAssistantText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const c = chunk as Chunk;
  const choice = c.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, c.output_text, c.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function cloneSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map((m) => ({ ...m })) : [],
  };
}

type ProviderMeta = { name?: string; serviceKinds?: string[] };
const providerMeta = (id: string | undefined) =>
  (AI_PROVIDERS as Record<string, ProviderMeta>)[id ?? ""];

/**
 * The provider's display name: registry name, compatible node name, else the
 * humanized provider id. Never the account name (often an OAuth email).
 */
export function getProviderLabel(connection: Connection | undefined): string {
  return (
    providerMeta(connection?.provider)?.name ||
    connection?.providerSpecificData?.nodeName ||
    humanize(connection?.provider || connection?.id || "provider")
  );
}

/** Model kinds the Playground can't chat with. */
const NON_CHAT_KINDS = new Set(["tts", "stt", "embedding", "image", "video"]);

/** Whether a provider serves chat models (unknown / compatible providers do). */
export function isChatProvider(providerId: string | undefined): boolean {
  const kinds = providerMeta(providerId)?.serviceKinds;
  return !kinds || kinds.includes("llm");
}

/** Whether a model entry is a chat model, judged by its `kind` / `type` metadata. */
export function isChatModel(model: unknown): boolean {
  if (!model || typeof model !== "object") return true;
  const m = model as { kind?: unknown; type?: unknown };
  return !NON_CHAT_KINDS.has(String(m.kind ?? "")) && !NON_CHAT_KINDS.has(String(m.type ?? ""));
}

export function normalizeStaticModel(
  model: { id?: string; name?: string } | null,
  connection: Connection,
): ChatModel | null {
  if (!model?.id) return null;
  return {
    id: `${connection.provider}/${model.id}`,
    requestModel: `${connection.provider}/${model.id}`,
    name: model.name || model.id,
    providerId: connection.provider ?? "",
    providerName: getProviderLabel(connection),
    source: "static",
  };
}

type LiveModel =
  | string
  | { id?: string; name?: string; model?: string; displayName?: string }
  | null;

export function normalizeLiveModel(model: LiveModel, connection: Connection): ChatModel | null {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;
  const displayName =
    typeof model === "string" ? model : model?.name || model?.displayName || rawId;

  let requestModel = rawId;
  const isCompatible =
    isOpenAICompatibleProvider(connection.provider) ||
    isAnthropicCompatibleProvider(connection.provider);
  if (isCompatible && !rawId.includes("/")) requestModel = `${connection.provider}/${rawId}`;

  return {
    id: requestModel,
    requestModel,
    name: displayName,
    providerId: connection.provider ?? "",
    providerName: getProviderLabel(connection),
    source: "live",
  };
}

export function parseProviderModelsPayload(data: unknown): LiveModel[] {
  const d = data as { models?: unknown; data?: unknown; results?: unknown } | null;
  if (Array.isArray(d?.models)) return d.models;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.results)) return d.results;
  if (Array.isArray(data)) return data;
  return [];
}

export function dedupeModels(models: ChatModel[]): ChatModel[] {
  const map = new Map<string, ChatModel>();
  for (const model of models) {
    if (model?.id && !map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

export function staticModelsFor(providerId: string, connection: Connection): ChatModel[] {
  return (getModelsByProviderId(providerId) as { id?: string; name?: string }[])
    .filter(isChatModel)
    .map((model) => normalizeStaticModel(model, connection))
    .filter((m): m is ChatModel => m !== null);
}

export function newSession(model: ChatModel): ChatSession {
  const now = new Date().toISOString();
  return {
    id: createId(),
    title: "New chat",
    providerId: model.providerId,
    providerName: model.providerName,
    modelId: model.id,
    modelName: model.name,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Splits markdown-ish text into prose and fenced code blocks. */
export type Segment = { kind: "text"; text: string } | { kind: "code"; lang: string; code: string };

export function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "code", lang: m[1] ?? "", code: (m[2] ?? "").replace(/\n$/, "") });
    last = re.lastIndex;
    if (m[0].length === 0) break;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.filter((s) => s.kind === "code" || s.text.trim());
}

/** Provider groups in the shape `ModelPicker` takes (the id sent upstream as detail). */
export function toPickerGroups(groups: ProviderGroup[]): {
  providerId: string;
  providerName: string;
  models: { id: string; name: string; detail: string }[];
}[] {
  return groups.map((g) => ({
    providerId: g.providerId,
    providerName: g.providerName,
    models: g.models.map((m) => ({ id: m.id, name: m.name, detail: m.requestModel })),
  }));
}

/** Recently used model ids from storage; anything malformed reads as none. */
export function parseRecentModels(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Height the on-screen keyboard covers at the bottom of the layout viewport,
 * from `window.innerHeight` and the visual viewport. 0 while pinch-zoomed or
 * when the gap is too small to be a keyboard (URL bar / toolbar changes).
 */
export function keyboardInset(
  layoutHeight: number,
  viewport: { height: number; offsetTop: number; scale: number },
): number {
  if (viewport.scale > 1.01) return 0;
  const gap = Math.round(layoutHeight - viewport.height - viewport.offsetTop);
  return gap > 80 ? gap : 0;
}
