"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { buildProviders, type Connection, type ProviderNode } from "./model";

type Notify = {
  success: (m: string) => void;
  warning: (m: string) => void;
  error: (m: string) => void;
};

interface BatchResult {
  summary?: { passed: number; failed: number; total: number; unsupported?: number };
  error?: string;
}

/**
 * Providers + connections, kept live: loads once, then refetches whenever the
 * server signals a change on /api/providers/stream. Mutations are optimistic;
 * the next live refresh reconciles them.
 */
export function useProviders() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [nodes, setNodes] = useState<ProviderNode[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumps on every successful refresh; embedded views re-fetch their own data on change.
  const [dataVersion, setDataVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const notify = useNotificationStore() as unknown as Notify;
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    // Coalesce: if a fetch is running, run exactly one more after it.
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const fetchOnce = async () => {
      try {
        const [cRes, nRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/provider-nodes"),
        ]);
        if (cRes.ok) setConnections(((await cRes.json()).connections ?? []) as Connection[]);
        if (nRes.ok) setNodes(((await nRes.json()).nodes ?? []) as ProviderNode[]);
        setDataVersion((v) => v + 1);
      } catch {
        // keep last good data; the stream will trigger another try
      } finally {
        setLoading(false);
      }
    };
    inflight.current = (async () => {
      do {
        again.current = false;
        await fetchOnce();
      } while (again.current);
    })().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
  }, []);

  useEffect(() => {
    void refresh();
    const es = new EventSource("/api/providers/stream");
    es.addEventListener("providers", () => void refresh());
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // EventSource reconnects by itself
    // Catch up after the tab was hidden (streams may have been dropped)
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const providers = useMemo(() => buildProviders(connections, nodes), [connections, nodes]);

  const setConnectionActive = useCallback(
    async (ids: string[], isActive: boolean) => {
      setConnections((prev) => prev.map((c) => (ids.includes(c.id) ? { ...c, isActive } : c)));
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/providers/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive }),
          }).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
          }),
        ),
      );
      if (results.some((r) => r.status === "rejected")) {
        notify.error("Couldn't update some accounts");
        void refresh();
      }
    },
    [notify, refresh],
  );

  /** mode "all" or a provider id. Results arrive via the live stream; we only toast the summary. */
  const runTest = useCallback(
    async (target: string) => // "all" or a provider id
      {
        if (testing) return;
        setTesting(target);
        try {
          const res = await fetch("/api/providers/test-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              target === "all" ? { mode: "all" } : { mode: "provider", providerId: target },
            ),
          });
          const data = (await res.json()) as BatchResult;
          if (data.summary) {
            const { passed, failed, total, unsupported = 0 } = data.summary;
            const tested = total - unsupported;
            const skipped = unsupported ? ` (${unsupported} have no connection test)` : "";
            if (total === 0) notify.warning("Nothing to test yet");
            else if (tested === 0) notify.warning("These accounts have no connection test");
            else if (failed === 0) notify.success(`All ${tested} tested accounts passed${skipped}`);
            else notify.warning(`${passed}/${tested} passed, ${failed} failed${skipped}`);
          } else {
            notify.error(data.error || "Test failed");
          }
        } catch {
          notify.error("Test request failed");
        } finally {
          setTesting(null);
          void refresh();
        }
      },
    [testing, notify, refresh],
  );

  const clearCooldown = useCallback(
    async (provider: string, model: string) => {
      try {
        const res = await fetch("/api/models/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "clearCooldown", provider, model }),
        });
        if (res.ok)
          notify.success(model === "__all" ? "Cooldown cleared" : `Cooldown cleared for ${model}`);
        else notify.error("Failed to clear cooldown");
      } catch {
        notify.error("Failed to clear cooldown");
      } finally {
        void refresh();
      }
    },
    [notify, refresh],
  );

  return {
    providers,
    connections,
    nodes,
    loading,
    dataVersion,
    live,
    testing,
    refresh,
    setConnectionActive,
    runTest,
    clearCooldown,
    setNodes,
  };
}
