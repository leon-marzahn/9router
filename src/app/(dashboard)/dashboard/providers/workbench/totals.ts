import { needsAttention } from "@/ui";
import type { ProviderEntry } from "../model";

export interface Totals {
  available: number;
  live: number;
  accounts: number;
  healthy: number;
  failing: number;
  free: number;
}

export const isLive = (p: ProviderEntry) => p.stats.total > 0 || p.noAuth;

export function totalsOf(providers: ProviderEntry[]): Totals {
  return {
    available: providers.length,
    live: providers.filter(isLive).length,
    accounts: providers.reduce((n, p) => n + p.stats.total, 0),
    healthy: providers.reduce((n, p) => n + p.stats.connected, 0),
    failing: providers.filter((p) => needsAttention(p.status)).length,
    free: providers.filter((p) => p.noAuth).length,
  };
}
