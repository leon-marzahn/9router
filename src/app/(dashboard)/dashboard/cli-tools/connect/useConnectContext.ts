"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export interface Endpoint {
  id: string;
  label: string;
  url: string;
}
export interface KeyOption {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
}

const noop = () => () => {};

/** Endpoints regent is reachable on (this machine, tunnel, Tailnet) and the dashboard's API keys. */
export function useConnectContext() {
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "");
  const [remote, setRemote] = useState<Endpoint[]>([]);
  const [keys, setKeys] = useState<KeyOption[] | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([
        fetch("/api/tunnel/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/keys", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]).then(([tunnel, k]) => {
        if (!live) return;
        const eps: Endpoint[] = [];
        if (tunnel?.tunnel?.settingsEnabled && tunnel.tunnel.tunnelUrl) eps.push({ id: "public", label: "Public URL", url: tunnel.tunnel.tunnelUrl });
        if (tunnel?.tailscale?.settingsEnabled && tunnel.tailscale.tunnelUrl) eps.push({ id: "tailnet", label: "Tailnet", url: tunnel.tailscale.tunnelUrl });
        setRemote(eps);
        setKeys(((k?.keys as KeyOption[]) ?? []).filter((x) => x.isActive));
      });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, []);

  const endpoints: Endpoint[] = [{ id: "local", label: "This machine", url: origin }, ...remote];
  return { endpoints, keys };
}

export const maskKey = (k: string) => (k.length > 10 ? `${k.slice(0, 6)}••••${k.slice(-4)}` : "••••");
