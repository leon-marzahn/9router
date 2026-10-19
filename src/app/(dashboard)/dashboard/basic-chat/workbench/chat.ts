import { getModelsByProviderId } from "@/shared/constants/models";
import {
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

export const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  draft: "basic-chat.draft",
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

export function getProviderLabel(connection: Connection | undefined): string {
  return connection?.name || humanize(connection?.provider || connection?.id || "provider");
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
