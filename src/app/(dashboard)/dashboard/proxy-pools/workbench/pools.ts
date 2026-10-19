import type { Status } from "@/ui";

export type PoolType = "http" | "vercel" | "cloudflare" | "deno" | "netlify";

export interface ProxyPool {
  id: string;
  name: string;
  proxyUrl: string;
  noProxy?: string;
  type?: PoolType;
  isActive: boolean;
  strictProxy?: boolean;
  testStatus?: string | null;
  lastTestedAt?: string | null;
  lastError?: string | null;
  boundConnectionCount?: number;
  updatedAt?: string;
}

export interface PoolForm {
  name: string;
  proxyUrl: string;
  noProxy: string;
  isActive: boolean;
  strictProxy: boolean;
}

export function toForm(data: Partial<ProxyPool> = {}): PoolForm {
  return {
    name: data.name || "",
    proxyUrl: data.proxyUrl || "",
    noProxy: data.noProxy || "",
    isActive: data.isActive !== false,
    strictProxy: data.strictProxy === true,
  };
}

/** Map a pool onto the shared status vocabulary. */
export function poolStatus(p: ProxyPool): Status {
  if (!p.isActive) return "paused";
  if (p.testStatus === "active") return "ok";
  if (p.testStatus === "error") return "error";
  return "none";
}

export const STATUS_TEXT: Record<Status, string> = {
  ok: "Reachable",
  error: "Unreachable",
  paused: "Inactive",
  none: "Untested",
  degraded: "Degraded",
  ready: "Ready",
  pending: "Testing",
};

export const RELAY_LABEL: Record<PoolType, string> = {
  http: "Proxy",
  vercel: "Vercel relay",
  cloudflare: "Cloudflare relay",
  deno: "Deno relay",
  netlify: "Netlify relay",
};

export function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

/** One line of a batch import: `scheme://user:pass@host:port` or `host:port:user:pass`. */
export function parseProxyLine(line: string): { proxyUrl: string; name: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    const parsed = new URL(trimmed);
    const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return { proxyUrl: parsed.toString(), name: `Imported ${hostLabel}` };
  }

  const parts = trimmed.split(":");
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password) {
      throw new Error("Invalid host:port:user:pass format");
    }
    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    return { proxyUrl: new URL(proxyUrl).toString(), name: `Imported ${host}:${port}` };
  }

  throw new Error("Unsupported format");
}
