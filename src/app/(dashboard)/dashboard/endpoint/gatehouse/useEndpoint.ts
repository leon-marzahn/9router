"use client";

import { useCallback, useEffect, useState } from "react";
import useSettingsStoreJs from "@/store/settingsStore";

export interface KeyAccess {
  restricted: boolean;
  allow: string[];
}
export interface ApiKey {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
  createdAt: string;
  access?: KeyAccess;
}
export interface Security {
  requireApiKey: boolean;
  requireLogin: boolean;
  hasPassword: boolean;
  tunnelDashboardAccess: boolean;
}

type SettingsStore = {
  getState: () => {
    fetchSettings: () => Promise<Record<string, any> | null>;
    patchSettings: (p: Record<string, unknown>) => Promise<unknown>;
  };
};
const settingsStore = useSettingsStoreJs as unknown as SettingsStore;

async function json(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** API keys and the security settings that decide whether going public is allowed. */
export function useEndpoint() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [security, setSecurity] = useState<Security | null>(null);

  const loadKeys = useCallback(async () => {
    let list: ApiKey[] = (await json("/api/keys").catch(() => ({ keys: [] }))).keys ?? [];
    // First visit: give the endpoint a key so it works out of the box.
    if (!list.length) {
      await json("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: "Default Key" }),
      }).catch(() => null);
      list = (await json("/api/keys").catch(() => ({ keys: [] }))).keys ?? [];
    }
    setKeys(list);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void loadKeys(), 0);
    void settingsStore
      .getState()
      .fetchSettings()
      .then((s) =>
        setSecurity({
          requireApiKey: !!s?.requireApiKey,
          requireLogin: s?.requireLogin !== false,
          hasPassword: !!s?.hasPassword,
          tunnelDashboardAccess: !!s?.tunnelDashboardAccess,
        }),
      );
    return () => clearTimeout(first);
  }, [loadKeys]);

  const setSetting = async (patch: Partial<Security>) => {
    const ok = await settingsStore.getState().patchSettings(patch);
    if (ok) setSecurity((s) => (s ? { ...s, ...patch } : s));
  };

  const updateKey = (id: string, p: Partial<ApiKey>) =>
    setKeys((ks) => ks?.map((k) => (k.id === id ? { ...k, ...p } : k)) ?? ks);

  return {
    keys,
    security,
    setSetting,
    createKey: async (name: string) => {
      await json("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
      await loadKeys();
    },
    deleteKey: async (id: string) => {
      await json(`/api/keys/${id}`, { method: "DELETE" });
      setKeys((ks) => ks?.filter((k) => k.id !== id) ?? ks);
    },
    setActive: async (id: string, isActive: boolean) => {
      await json(`/api/keys/${id}`, { method: "PUT", body: JSON.stringify({ isActive }) });
      updateKey(id, { isActive });
    },
    setAccess: async (id: string, access: KeyAccess) => {
      const data = await json(`/api/keys/${id}`, {
        method: "PUT",
        body: JSON.stringify({ access }),
      });
      updateKey(id, { access: data.key?.access ?? access });
    },
  };
}
