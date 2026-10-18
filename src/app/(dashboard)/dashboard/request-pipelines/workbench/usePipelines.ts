"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";
import type { Pipeline, PipelineUsage } from "./steps";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
export const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

export async function json(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export interface Named {
  id: string;
  name: string;
}

/**
 * Saved pipelines plus a local draft. Edits change the draft; save() sends the
 * whole list (the settings API validates it) and replaces both with the result.
 */
export function usePipelines() {
  const [saved, setSaved] = useState<Pipeline[] | null>(null);
  const [draft, setDraft] = useState<Pipeline[] | null>(null);
  const [usage, setUsage] = useState<Record<string, PipelineUsage>>({});
  const [keys, setKeys] = useState<Named[]>([]);
  const [combos, setCombos] = useState<Named[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setUsage((await json("/api/settings/request-pipelines/stats")).stats || {});
    } catch {
      /* stats are optional */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(async () => {
      try {
        const [s, k, c] = await Promise.all([
          json("/api/settings"),
          json("/api/keys").catch(() => ({ keys: [] })),
          json("/api/combos").catch(() => ({ combos: [] })),
        ]);
        const list = (s.requestPipelines || []) as Pipeline[];
        setSaved(list);
        setDraft(list);
        setKeys((k.keys || []).map((x: Named) => ({ id: x.id, name: x.name || x.id })));
        setCombos(
          (c.combos || [])
            .filter((x: { kind?: string }) => !x.kind || x.kind === "llm")
            .map((x: Named) => ({ id: x.name, name: x.name })),
        );
      } catch (e) {
        notify().error((e as Error).message);
        setSaved([]);
        setDraft([]);
      }
      void loadUsage();
    }, 0);
    const timer = setInterval(loadUsage, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadUsage]);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  const change = (next: Pipeline[]) => {
    setDraft(next);
    setError(null);
  };
  const update = (name: string, next: Pipeline) =>
    change((draft ?? []).map((p) => (p.name === name ? next : p)));

  const save = async () => {
    setSaving(true);
    try {
      const data = await json("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ requestPipelines: draft }),
      });
      setSaved(data.requestPipelines);
      setDraft(data.requestPipelines);
      setError(null);
      notify().success("Pipelines saved. New requests use them right away.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    pipelines: draft,
    saved,
    usage,
    keys,
    combos,
    dirty,
    saving,
    error,
    change,
    update,
    save,
    discard: () => change(saved ?? []),
  };
}
export type PipelinesApi = ReturnType<typeof usePipelines>;
