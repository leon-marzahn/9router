"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";

export type Strategy = "fallback" | "round-robin" | "per-chat" | "fusion";
export interface Combo {
  id: string;
  name: string;
  kind: string | null;
  models: string[];
}
export interface ComboSettings {
  fallbackStrategy?: Strategy;
  stickAfterFallback?: boolean;
  judgeModel?: string;
  fusionTuning?: unknown;
}
export interface StepReadiness {
  state: "ready" | "cooling" | "off" | "combo" | "unknown";
  provider?: string;
  accounts: number;
  ready: number;
  until: string | null;
}

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void; warning: (m: string) => void } };
export const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

async function json(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const READINESS_MS = 15_000;

/** Combos (LLM kind only), their per-combo routing settings, and live step readiness. */
export function useCombos() {
  const [combos, setCombos] = useState<Combo[] | null>(null);
  const [strategies, setStrategies] = useState<Record<string, ComboSettings>>({});
  const [globalStrategy, setGlobalStrategy] = useState<Strategy>("fallback");
  const [readiness, setReadiness] = useState<Record<string, StepReadiness>>({});

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([json("/api/combos"), json("/api/settings")]);
      setCombos((c.combos as Combo[]).filter((x) => !x.kind || x.kind === "llm"));
      setStrategies(s.comboStrategies || {});
      setGlobalStrategy((s.comboStrategy as Strategy) || "fallback");
    } catch (e) {
      notify().error((e as Error).message);
      setCombos((c) => c ?? []);
    }
  }, []);

  const loadReadiness = useCallback(async () => {
    try {
      setReadiness((await json("/api/combos/readiness")).steps || {});
    } catch {
      /* keep the last known readiness */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => {
      void load();
      void loadReadiness();
    }, 0);
    const t = setInterval(() => !document.hidden && void loadReadiness(), READINESS_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, loadReadiness]);

  const saveStrategies = async (next: Record<string, ComboSettings>) => {
    const prev = strategies;
    setStrategies(next);
    try {
      await json("/api/settings", { method: "PATCH", body: JSON.stringify({ comboStrategies: next }) });
    } catch (e) {
      setStrategies(prev);
      notify().error((e as Error).message);
    }
  };

  const warn = (data: { warning?: { model: string } }, name: string) => {
    if (data.warning)
      notify().warning(`"${name}" is also a model name (${data.warning.model}); requests for it now go through this combo. Use combo/${name} to always mean the combo.`);
  };

  return {
    combos,
    strategies,
    globalStrategy,
    readiness,
    reload: load,
    settingsFor: (name: string): ComboSettings => strategies[name] || {},
    strategyOf: (name: string): Strategy => strategies[name]?.fallbackStrategy || globalStrategy,
    setSettings: (name: string, patch: ComboSettings) => {
      const merged = { ...(strategies[name] || {}), ...patch };
      const next = { ...strategies, [name]: merged };
      return saveStrategies(next);
    },
    create: async (name: string, models: string[]) => {
      const data = await json("/api/combos", { method: "POST", body: JSON.stringify({ name, models }) });
      warn(data, name);
      await load();
      void loadReadiness();
      return data as Combo;
    },
    update: async (id: string, patch: Partial<Combo>) => {
      const data = await json(`/api/combos/${id}`, { method: "PUT", body: JSON.stringify(patch) });
      if (patch.name) warn(data, patch.name);
      await load();
      void loadReadiness();
      return data as Combo;
    },
    remove: async (c: Combo) => {
      await json(`/api/combos/${c.id}`, { method: "DELETE" });
      if (strategies[c.name]) {
        const next = { ...strategies };
        delete next[c.name];
        await saveStrategies(next);
      }
      await load();
    },
  };
}

export type CombosApi = ReturnType<typeof useCombos>;
