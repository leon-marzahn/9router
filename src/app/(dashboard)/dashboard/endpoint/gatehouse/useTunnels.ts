"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type TunnelKind = "cloudflare" | "tailscale";
export type Phase = "checking" | "off" | "starting" | "on";

export interface TunnelState {
  phase: Phase;
  url: string;
  /** Browser could reach `${url}/api/health` (null until the first ping). */
  reachable: boolean | null;
  everReachable: boolean;
  progress: string;
  error: string | null;
  /** Tailscale login / Funnel page the user has to open to continue. */
  auth: { url: string; label: string } | null;
}

const IDLE: TunnelState = {
  phase: "checking",
  url: "",
  reachable: null,
  everReachable: false,
  progress: "",
  error: null,
  auth: null,
};

const PING_TIMEOUT_MS = 5000;
const READY_PING_MS = 2000;
const READY_MAX_MS = 5 * 60_000;
const DEGRADED_POLL_MS = 10_000;
const MISSES_BEFORE_DOWN = 5;
const AUTH_POLL_MS = 3000;
const AUTH_POLL_TRIES = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Browser-side health probe through the tunnel (/api/health allows any origin). */
export async function pingUrl(url: string) {
  if (!url) return false;
  try {
    const res = await fetch(`${url}/api/health`, {
      mode: "cors",
      cache: "no-store",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function post(path: string) {
  const res = await fetch(path, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data } as { ok: boolean; data: Record<string, any> };
}

/**
 * Cloudflare quick tunnel + Tailscale Funnel state. Every start runs under a
 * run id; Stop bumps it (so the client loops give up) and calls the server's
 * disable route, which cancels the in-flight start and kills the process.
 */
export function useTunnels() {
  const [state, setState] = useState<Record<TunnelKind, TunnelState>>({
    cloudflare: IDLE,
    tailscale: IDLE,
  });
  const run = useRef<Record<TunnelKind, number>>({ cloudflare: 0, tailscale: 0 });
  const misses = useRef<Record<TunnelKind, number>>({ cloudflare: 0, tailscale: 0 });

  const patch = useCallback(
    (kind: TunnelKind, p: Partial<TunnelState>) =>
      setState((s) => ({ ...s, [kind]: { ...s[kind], ...p } })),
    [],
  );
  const live = (kind: TunnelKind, id: number) => run.current[kind] === id;

  const sync = useCallback(async () => {
    try {
      const res = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState((s) => {
        const next = { ...s };
        for (const [kind, raw] of [
          ["cloudflare", data.tunnel],
          ["tailscale", data.tailscale],
        ] as const) {
          if (s[kind].phase === "starting") continue;
          const enabled = raw?.settingsEnabled ?? raw?.enabled ?? false;
          next[kind] = {
            ...s[kind],
            phase: enabled ? "on" : "off",
            url: enabled ? raw?.tunnelUrl || "" : "",
            reachable: enabled ? s[kind].reachable : null,
          };
        }
        return next;
      });
    } catch {
      /* keep the last known state */
    }
  }, []);

  const ping = useCallback(
    async (kind: TunnelKind, url: string) => {
      const ok = await pingUrl(url);
      if (ok) {
        misses.current[kind] = 0;
        patch(kind, { reachable: true, everReachable: true });
      } else if (++misses.current[kind] >= MISSES_BEFORE_DOWN) {
        // One miss is often a DNS hiccup; only show it as down after several.
        patch(kind, { reachable: false });
      }
      return ok;
    },
    [patch],
  );

  useEffect(() => {
    const first = setTimeout(() => void sync(), 0);
    return () => clearTimeout(first);
  }, [sync]);

  // While a tunnel is on but not answering, re-check it (and the server's view) every 10s.
  const cf = state.cloudflare;
  const ts = state.tailscale;
  useEffect(() => {
    const targets = (
      [
        ["cloudflare", cf],
        ["tailscale", ts],
      ] as const
    ).filter(([, t]) => t.phase === "on" && t.url);
    if (!targets.length) return;
    const tick = () => {
      if (document.hidden) return;
      for (const [kind, t] of targets) void ping(kind, t.url);
    };
    tick();
    const onVisible = () => {
      if (!document.hidden) void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    const degraded = targets.some(([, t]) => t.reachable !== true);
    const id = degraded
      ? setInterval(() => {
          tick();
          void sync();
        }, DEGRADED_POLL_MS)
      : undefined;
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cf.phase, cf.url, cf.reachable, ts.phase, ts.url, ts.reachable, ping, sync]);

  /** Ping until the new URL answers, the run is stopped, or 5 minutes pass. */
  const waitReady = async (kind: TunnelKind, id: number, url: string) => {
    patch(kind, { progress: "Waiting for the URL to answer…" });
    const start = Date.now();
    while (live(kind, id) && Date.now() - start < READY_MAX_MS) {
      if (await pingUrl(url)) return true;
      await sleep(READY_PING_MS);
    }
    return false;
  };

  const finish = (kind: TunnelKind, id: number, url: string, ok: boolean) => {
    if (!live(kind, id)) return;
    misses.current[kind] = 0;
    patch(kind, {
      phase: "on",
      url,
      reachable: ok,
      everReachable: ok,
      progress: "",
      auth: null,
      error: ok ? null : "Started, but the URL isn't answering yet.",
    });
  };
  const fail = (kind: TunnelKind, id: number, error: string) => {
    if (live(kind, id)) patch(kind, { phase: "off", progress: "", auth: null, error });
  };

  const startCloudflare = async () => {
    const id = ++run.current.cloudflare;
    patch("cloudflare", { phase: "starting", progress: "Starting tunnel…", error: null });
    // Report the cloudflared download while the enable request is pending.
    let waiting = true;
    void (async () => {
      while (waiting && live("cloudflare", id)) {
        try {
          const s = await (await fetch("/api/tunnel/status", { cache: "no-store" })).json();
          if (waiting && live("cloudflare", id))
            patch("cloudflare", {
              progress: s.download?.downloading
                ? `Downloading cloudflared… ${s.download.progress}%`
                : "Starting tunnel…",
            });
        } catch {
          /* ignore */
        }
        await sleep(1000);
      }
    })();
    try {
      const { ok, data } = await post("/api/tunnel/enable");
      waiting = false;
      if (!ok || !data.tunnelUrl)
        return fail("cloudflare", id, data.error || "Couldn't start the tunnel");
      if (live("cloudflare", id)) patch("cloudflare", { url: data.tunnelUrl });
      finish("cloudflare", id, data.tunnelUrl, await waitReady("cloudflare", id, data.tunnelUrl));
    } catch (e) {
      fail("cloudflare", id, (e as Error).message);
    } finally {
      waiting = false;
    }
  };

  const startTailscale = async () => {
    const id = ++run.current.tailscale;
    patch("tailscale", { phase: "starting", progress: "Connecting…", error: null, auth: null });
    const enable = () => post("/api/tunnel/tailscale-enable");
    try {
      let { ok, data } = await enable();
      if (data.needsLogin && data.authUrl) {
        patch("tailscale", {
          auth: { url: data.authUrl, label: "Log in to Tailscale" },
          progress: "Log in to Tailscale to continue",
        });
        let loggedIn = false;
        for (let i = 0; i < AUTH_POLL_TRIES && live("tailscale", id) && !loggedIn; i++) {
          await sleep(AUTH_POLL_MS);
          try {
            loggedIn = !!(await (await fetch("/api/tunnel/tailscale-check")).json()).loggedIn;
          } catch {
            /* retry */
          }
        }
        if (!live("tailscale", id)) return;
        if (!loggedIn) return fail("tailscale", id, "Login timed out. Try again.");
        patch("tailscale", { auth: null, progress: "Starting Funnel…" });
        ({ ok, data } = await enable());
      }
      if (data.funnelNotEnabled && data.enableUrl) {
        patch("tailscale", {
          auth: { url: data.enableUrl, label: "Turn on Funnel" },
          progress: "Allow Funnel for this device to continue",
        });
        for (let i = 0; i < AUTH_POLL_TRIES && live("tailscale", id); i++) {
          await sleep(AUTH_POLL_MS);
          ({ ok, data } = await enable());
          if (!data.funnelNotEnabled) break;
        }
        if (!live("tailscale", id)) return;
        if (data.funnelNotEnabled) return fail("tailscale", id, "Timed out waiting for Funnel.");
      }
      if (!ok || !data.success) return fail("tailscale", id, data.error || "Couldn't connect");
      if (live("tailscale", id)) patch("tailscale", { url: data.tunnelUrl, auth: null });
      finish("tailscale", id, data.tunnelUrl, await waitReady("tailscale", id, data.tunnelUrl));
    } catch (e) {
      fail("tailscale", id, (e as Error).message);
    }
  };

  /** Turn off, or cancel a start in progress. */
  const stop = async (kind: TunnelKind) => {
    run.current[kind]++;
    patch(kind, { phase: "off", progress: "", auth: null, error: null, url: "", reachable: null });
    const { ok, data } = await post(
      kind === "cloudflare" ? "/api/tunnel/disable" : "/api/tunnel/tailscale-disable",
    ).catch((e: Error) => ({ ok: false, data: { error: e.message } }));
    if (!ok) patch(kind, { error: data.error || "Couldn't turn it off" });
    void sync();
  };

  return { state, startCloudflare, startTailscale, stop };
}
