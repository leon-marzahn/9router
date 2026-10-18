"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";

export type Settings = Record<string, any>;

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
export const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

/** Settings from /api/settings, plus a save that reports failures instead of swallowing them. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (res.ok) setSettings(await res.json());
    } catch {
      notify().error("Couldn't load settings");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void reload(), 0);
    return () => clearTimeout(first);
  }, [reload]);

  /** PATCH and merge. Throws with the server's message; callers that don't catch get a toast. */
  const save = useCallback(async (patch: Settings, { quiet = false } = {}) => {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error || "Couldn't save";
      if (!quiet) notify().error(msg);
      throw new Error(msg);
    }
    setSettings((s) => ({ ...s, ...data }));
    return data as Settings;
  }, []);

  return { settings, save, reload };
}

export type SettingsApi = ReturnType<typeof useSettings>;
