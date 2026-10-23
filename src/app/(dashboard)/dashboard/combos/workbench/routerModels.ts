"use client";

import { useEffect, useState } from "react";
import type { PickerGroup } from "@/ui";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models";

type ProviderInfo = { name?: string; noAuth?: boolean; serviceKinds?: string[] };
type Model = { id: string; name?: string; kind?: string; type?: string };
type Conn = { provider: string; isActive?: boolean };

/**
 * System One models a smart combo can use as its router, grouped by provider: every
 * provider that serves the "systemone" kind and has an active account (or needs none).
 * The id is what the combo stores and sends (`alias/model`).
 */
export function systemOneGroups(connections: Conn[]): PickerGroup[] {
  const connected = new Set(connections.filter((c) => c.isActive !== false).map((c) => c.provider));
  const providers = AI_PROVIDERS as Record<string, ProviderInfo>;
  return Object.entries(providers)
    .filter(([id, p]) => p.serviceKinds?.includes("systemone") && (p.noAuth || connected.has(id)))
    .map(([id, p]) => {
      const alias = getProviderAlias(id) as string;
      const models = (getModelsByProviderId(id) as Model[])
        .filter((m) => getModelKind(m) === "systemone")
        .map((m) => ({ id: `${alias}/${m.id}`, name: m.name || m.id, detail: `${alias}/${m.id}` }));
      return { providerId: id, providerName: p.name || id, models };
    })
    .filter((g) => g.models.length > 0);
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
