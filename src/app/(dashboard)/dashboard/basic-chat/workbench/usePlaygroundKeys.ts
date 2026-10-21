"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProviderGroup } from "./chat";

/** A key as the picker sees it: never the secret. */
export interface PlaygroundKey {
  id: string;
  name: string;
  isActive: boolean;
  restricted: boolean;
  playground: boolean;
}

const STORAGE_KEY = "basic-chat.keyId";
/** Placeholder the server turns into the auto-created "Playground" key. */
export const PLAYGROUND_KEY_ID = "playground";

function readKeyId(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * The API key the Playground sends as (remembered in localStorage, defaulting to the
 * Playground key), and for a restricted key the model ids it may call.
 */
export function usePlaygroundKeys(groups: ProviderGroup[]) {
  const [keys, setKeys] = useState<PlaygroundKey[]>([]);
  const [saved, setSaved] = useState(readKeyId);
  const [fetched, setFetched] = useState<{ keyId: string; models: Set<string> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/chat/keys", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d) => {
        if (!cancelled) setKeys(Array.isArray(d.keys) ? d.keys : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const fallback = keys.find((k) => k.playground)?.id ?? PLAYGROUND_KEY_ID;
  const keyId = keys.some((k) => k.id === saved) ? saved : fallback;
  const key = keys.find((k) => k.id === keyId) ?? null;
  const modelIds = useMemo(
    () => groups.flatMap((g) => g.models.map((m) => m.requestModel || m.id)),
    [groups],
  );

  // Restricted keys only; null (no filter) for an open key or until the answer arrives.
  const allowed = key?.restricted && fetched?.keyId === keyId ? fetched.models : null;

  useEffect(() => {
    if (!key?.restricted) return;
    let cancelled = false;
    fetch("/api/dashboard/chat/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId, models: modelIds }),
    })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => {
        if (!cancelled)
          setFetched({ keyId, models: new Set(Array.isArray(d.models) ? d.models : []) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key?.restricted, keyId, modelIds]);

  const select = (id: string) => {
    setSaved(id);
    try {
      globalThis.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Ignore storage errors.
    }
  };

  /** Groups limited to what the key may call (all of them for an unrestricted key). */
  const visibleGroups = useMemo(
    () =>
      allowed
        ? groups
            .map((g) => ({
              ...g,
              models: g.models.filter((m) => allowed.has(m.requestModel || m.id)),
            }))
            .filter((g) => g.models.length > 0)
        : groups,
    [groups, allowed],
  );

  return { keys, keyId, select, visibleGroups };
}
