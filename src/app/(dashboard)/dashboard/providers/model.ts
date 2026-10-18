// Provider list model: turns raw connections + custom nodes into the
// normalized, status-annotated entries the Providers workbench renders.

import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { STATUS_ORDER, type Status } from "@/ui/status";

export type ProviderKind = "custom" | "oauth" | "free" | "freeTier" | "apikey";

export const KIND_LABEL: Record<ProviderKind, string> = {
  custom: "Custom",
  oauth: "OAuth",
  free: "Free",
  freeTier: "Free tier",
  apikey: "API key",
};

/** Sanitized connection as returned by GET /api/providers (no secrets). */
export interface Connection {
  id: string;
  provider: string;
  authType: string;
  name?: string;
  email?: string;
  displayName?: string;
  isActive?: boolean;
  priority?: number;
  testStatus?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastErrorType?: string;
  errorCode?: string | number;
  [key: string]: unknown;
}

export interface ProviderNode {
  id: string;
  type: string;
  name?: string;
  prefix?: string;
  apiType?: string;
  baseUrl?: string;
}

interface ProviderInfo {
  id?: string;
  name: string;
  color?: string;
  textIcon?: string;
  priority?: number;
  noAuth?: boolean;
  hidden?: boolean;
  authModes?: string[];
  serviceKinds?: string[];
}

export interface ProviderStats {
  total: number;
  connected: number;
  error: number;
  allDisabled: boolean;
  errorCode: string | null;
  errorTime: string | null;
  lastError: string | null;
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  color?: string;
  textIcon?: string;
  iconSrc: string | null;
  noAuth: boolean;
  apiType?: string;
  baseUrl?: string;
  authTypes: string[];
  connections: Connection[];
  stats: ProviderStats;
  status: Status;
}

const oauth = OAUTH_PROVIDERS as Record<string, ProviderInfo>;
const apikey = APIKEY_PROVIDERS as Record<string, ProviderInfo>;
const free = FREE_PROVIDERS as Record<string, ProviderInfo>;
const freeTier = FREE_TIER_PROVIDERS as Record<string, ProviderInfo>;

const isLlm = (info: ProviderInfo) => (info.serviceKinds ?? ["llm"]).includes("llm");

// Dual-auth providers store API keys as "apikey" (sometimes "api_key"); count
// both so list totals match the detail page. kiro accepts both without
// declaring authModes; free-tier/API-key providers default to accepting keys.
function authTypesFor(key: string, info: ProviderInfo): string[] {
  const dual = ["oauth", "apikey", "api_key"];
  if (key === "kiro") return dual;
  if (!Array.isArray(info.authModes)) return key in freeTier || key in apikey ? dual : ["oauth"];
  return info.authModes.includes("apikey") ? dual : ["oauth"];
}

/** Short tag for a connection's last failure: AUTH, 429, 5XX, NET, RUNTIME, a status code, or ERR. */
export function errorTag(c: Connection): string {
  const t = c.lastErrorType;
  if (t === "runtime_error") return "RUNTIME";
  if (
    t === "upstream_auth_error" ||
    t === "auth_missing" ||
    t === "token_refresh_failed" ||
    t === "token_expired"
  )
    return "AUTH";
  if (t === "upstream_rate_limited") return "429";
  if (t === "upstream_unavailable") return "5XX";
  if (t === "network_error") return "NET";

  const code = Number(c.errorCode);
  if (Number.isFinite(code) && code >= 400) return String(code);

  const fromMessage = getErrorCode(c.lastError ?? "") as string | null;
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (c.lastError || "").toLowerCase();
  if (msg.includes("runtime") || msg.includes("not runnable") || msg.includes("not installed"))
    return "RUNTIME";
  if (["invalid api key", "token invalid", "revoked", "unauthorized"].some((s) => msg.includes(s)))
    return "AUTH";
  return "ERR";
}

// "unavailable" without an active model cooldown means the account recovered.
function effectiveStatus(c: Connection): string | undefined {
  const cooling = Object.entries(c).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v as string).getTime() > Date.now(),
  );
  return c.testStatus === "unavailable" && !cooling ? "active" : c.testStatus;
}

export const isFailing = (c: Connection) =>
  ["error", "expired", "unavailable"].includes(effectiveStatus(c) ?? "");
const isHealthy = (c: Connection) => ["active", "success"].includes(effectiveStatus(c) ?? "");

export function connectionLabel(c: Connection): string {
  return (
    c.name || c.email || c.displayName || (c.authType === "oauth" ? "OAuth account" : "API key")
  );
}

function statsFor(conns: Connection[]): ProviderStats {
  const failing = conns
    .filter(isFailing)
    .sort((a, b) => +new Date(b.lastErrorAt || 0) - +new Date(a.lastErrorAt || 0));
  const latest = failing[0];
  return {
    total: conns.length,
    connected: conns.filter(isHealthy).length,
    error: failing.length,
    allDisabled: conns.length > 0 && conns.every((c) => c.isActive === false),
    errorCode: latest ? errorTag(latest) : null,
    errorTime: latest?.lastErrorAt ? (getRelativeTime(latest.lastErrorAt) as string) : null,
    lastError: latest?.lastError ?? null,
  };
}

function statusFor(noAuth: boolean, s: ProviderStats): Status {
  if (noAuth) return "ready";
  if (s.total === 0) return "none";
  if (s.allDisabled) return "paused";
  if (s.error > 0) return s.connected > 0 ? "degraded" : "error";
  return "ok";
}

/** All LLM providers (built-in + custom nodes), sorted problems-first then by name. */
export function buildProviders(connections: Connection[], nodes: ProviderNode[]): ProviderEntry[] {
  const byProvider = new Map<string, Connection[]>();
  for (const c of connections) {
    const list = byProvider.get(c.provider);
    if (list) list.push(c);
    else byProvider.set(c.provider, [c]);
  }

  const out = new Map<string, ProviderEntry>();
  const add = (
    id: string,
    kind: ProviderKind,
    info: ProviderInfo,
    authTypes: string[],
    iconSrc: string | null,
    extra: Partial<ProviderEntry> = {},
  ) => {
    if (out.has(id) || info.hidden) return;
    const conns = (byProvider.get(id) ?? []).filter((c) => authTypes.includes(c.authType));
    const stats = statsFor(conns);
    const noAuth = !!info.noAuth;
    out.set(id, {
      id,
      kind,
      iconSrc,
      noAuth,
      authTypes,
      name: info.name,
      color: info.color,
      textIcon: info.textIcon,
      connections: conns,
      stats,
      status: statusFor(noAuth, stats),
      ...extra,
    });
  };

  for (const n of nodes) {
    if (n.type !== "openai-compatible" && n.type !== "anthropic-compatible") continue;
    const anthropic = n.id.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
    add(
      n.id,
      "custom",
      {
        name: n.name || (anthropic ? "Anthropic Compatible" : "OpenAI Compatible"),
        color: anthropic ? "#D97757" : "#10A37F",
        textIcon: anthropic ? "AC" : "OC",
      },
      ["apikey"],
      anthropic
        ? "/providers/anthropic-m.png"
        : n.apiType === "responses"
          ? "/providers/oai-r.png"
          : "/providers/oai-cc.png",
      { apiType: n.apiType, baseUrl: n.baseUrl },
    );
  }
  for (const [k, info] of Object.entries(oauth))
    add(k, "oauth", info, authTypesFor(k, info), getProviderIconSrc(info.id || k));
  for (const [k, info] of Object.entries(free))
    add(k, "free", info, authTypesFor(k, info), getProviderIconSrc(info.id || k));
  for (const [k, info] of Object.entries(freeTier))
    if (isLlm(info))
      add(k, "freeTier", info, authTypesFor(k, info), getProviderIconSrc(info.id || k));
  for (const [k, info] of Object.entries(apikey))
    if (isLlm(info)) add(k, "apikey", info, ["apikey"], getProviderIconSrc(info.id || k));

  return [...out.values()].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
}

/** A primitive that changes whenever the row's visible state changes (drives the live flash). */
export const versionOf = (p: ProviderEntry) =>
  `${p.status}:${p.stats.connected}/${p.stats.total}:${p.stats.errorCode ?? ""}`;
