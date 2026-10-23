"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderGroup } from "./chat";
import {
  KEY_STORAGE,
  allowedFor,
  billsAnotherKey,
  filterGroups,
  parseKeys,
  requestModelIds,
  resolveKeyId,
  type PlaygroundKey,
} from "./playgroundKeys";

export type { PlaygroundKey } from "./playgroundKeys";

function readSaved(): string {
  try {
    return globalThis.localStorage?.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

/**
 * The API key the Playground sends as (remembered in localStorage, defaulting to the
 * Playground key) and the provider groups limited to what that key may call.
 */
export function usePlaygroundKeys(groups: ProviderGroup[]) {
  const [keys, setKeys] = useState<PlaygroundKey[] | null>(null);
  const [saved, setSaved] = useState(readSaved);
  const [fetched, setFetched] = useState<{ keyId: string; models: string[] } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/chat/keys", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setKeys(parseKeys(d));
      })
      .catch(() => {
        if (!cancelled) setKeys(null);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const keyId = resolveKeyId(keys, saved);
  const key = keys?.find((k) => k.id === keyId) ?? null;
  const modelIds = useMemo(() => requestModelIds(groups), [groups]);
  const restricted = !!key?.restricted;

  useEffect(() => {
    if (!restricted || !keyId) return;
    let cancelled = false;
    fetch("/api/dashboard/chat/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId, models: modelIds }),
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => {
        if (!cancelled) setFetched({ keyId, models: Array.isArray(d.models) ? d.models : [] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [restricted, keyId, modelIds]);

  const allowed = useMemo(() => allowedFor(key, fetched), [key, fetched]);
  const visibleGroups = useMemo(() => filterGroups(groups, allowed), [groups, allowed]);

  const select = (id: string) => {
    setSaved(id);
    try {
      globalThis.localStorage.setItem(KEY_STORAGE, id);
    } catch {
      // Ignore storage errors.
    }
  };

  /** Re-read the list (after the first send created the Playground key). */
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return {
    keys: keys ?? [],
    keyId,
    select,
    refresh,
    visibleGroups,
    billsAnotherKey: billsAnotherKey(keys, keyId),
  };
}
