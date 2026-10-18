"use client";

import { useCallback, useEffect, useState } from "react";

export type HookResult = {
  ok: boolean;
  at: string;
  version: string;
  test?: boolean;
  status?: number;
  error?: string;
};

export type UpdateInfo = {
  current: string;
  checkEnabled: boolean;
  update: { version: string; url: string } | null;
  webhook: {
    set: boolean;
    hasToken: boolean;
    host: string | null;
    channel: "major" | "any";
    lastVersion: string | null;
    lastResult: HookResult | null;
  };
};

let shared: Promise<UpdateInfo | null> | null = null;
const load = (force = false) => {
  if (force || !shared) {
    shared = fetch("/api/settings/updates", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<UpdateInfo>) : null))
      .catch(() => null);
  }
  return shared;
};

/** Update notice + redeploy-hook state from /api/settings/updates (one request per page load). */
export function useUpdate() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((d) => live && setInfo(d));
    return () => {
      live = false;
    };
  }, []);
  const reload = useCallback(async () => setInfo(await load(true)), []);
  return { info, setInfo, reload };
}
