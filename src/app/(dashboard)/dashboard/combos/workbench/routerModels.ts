"use client";

import { useEffect, useState } from "react";
import type { PickerGroup } from "@/ui";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";

type ProviderInfo = { name?: string; noAuth?: boolean; serviceKinds?: string[] };
type Model = { id: string; name?: string; kind?: string; type?: string };
type Conn = { provider: string; isActive?: boolean };

/** Shown wherever a no-account (free, third-party) router lane appears. */
export const FREE_ROUTER_NOTE = "Free third-party · prompts may be logged";

/** Provider of a stored router id (`alias/model`), by alias or id. */
function providerOf(routerId: string): ProviderInfo | undefined {
  const prefix = routerId.split("/")[0];
  const providers = AI_PROVIDERS as Record<string, ProviderInfo>;
  return (
    providers[prefix] ||
    Object.entries(providers).find(([id]) => getProviderAlias(id) === prefix)?.[1]
  );
}

/**
 * True when the router runs on a no-account lane: a free third-party service the
 * operator has no agreement with, which sees each routed message.
 */
export function isFreeThirdPartyRouter(routerId: string | null | undefined): boolean {
  return !!routerId && !!providerOf(routerId)?.noAuth;
}

/**
 * System One models a smart combo can use as its router, grouped by provider: every
 * provider that serves the "systemone" kind and has an active account, then (last, and
 * labelled) the free no-account lanes. The id is what the combo stores and sends
 * (`alias/model`).
 */
export function systemOneGroups(connections: Conn[]): PickerGroup[] {
  const connected = new Set(connections.filter((c) => c.isActive !== false).map((c) => c.provider));
  const providers = AI_PROVIDERS as Record<string, ProviderInfo>;
  const groups = Object.entries(providers)
    .filter(([id, p]) => p.serviceKinds?.includes("systemone") && (p.noAuth || connected.has(id)))
    .map(([id, p]) => {
      const alias = getProviderAlias(id) as string;
      const free = !!p.noAuth;
      const models = (getModelsByProviderId(id) as Model[])
        .filter((m) => getModelKind(m) === "systemone")
        .map((m) => ({
          id: `${alias}/${m.id}`,
          name: m.name || m.id,
          detail: free ? `${alias}/${m.id} · ${FREE_ROUTER_NOTE}` : `${alias}/${m.id}`,
        }));
      const providerName = free ? `${p.name || id} · ${FREE_ROUTER_NOTE}` : p.name || id;
      return { providerId: id, providerName, models, free };
    })
    .filter((g) => g.models.length > 0);
  // Authenticated lanes first; the stable sort keeps registry order within each.
  return groups.sort((a, b) => Number(a.free) - Number(b.free)).map(({ free: _free, ...g }) => g);
}

/** Router candidates, loaded once the smart strategy is shown. */
export function useRouterModels(enabled: boolean): PickerGroup[] | null {
  const [groups, setGroups] = useState<PickerGroup[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connections: [] }))
      .then(
        (d: { connections?: Conn[] }) => alive && setGroups(systemOneGroups(d.connections || [])),
      )
      .catch(() => alive && setGroups(systemOneGroups([])));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return groups;
}
