"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Field, Icon, Tag } from "@/ui";

const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const save = useCallback(async (poolId, strategy) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setSaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const canRotate = proxyPools.length >= 2;
  const isRotation = rotateStrategy !== "none";

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-info/12 text-info-text">
          <Icon name="lock_open" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">Ready to use. Optionally route requests through a proxy pool to get around IP-based limits.</p>
        </div>
        {savedFlash && <Tag tone="success">saved</Tag>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Proxy pool" hint={isRotation ? "Ignored while rotation is on — all active pools are used." : undefined}>
          <select
            value={proxyPoolId}
            onChange={(e) => handlePoolChange(e.target.value)}
            disabled={saving || isRotation}
            className="h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-[13px] text-text outline-none focus:border-accent disabled:opacity-50 dark:border-border"
          >
            <option value={NONE_PROXY_POOL_VALUE}>None (direct)</option>
            {proxyPools.map((pool) => (
              <option key={pool.id} value={pool.id}>{pool.name}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Rotation"
          hint={!canRotate
            ? "Needs at least 2 active proxy pools."
            : isRotation
              ? rotateStrategy === "round-robin"
                ? `Rotating through all ${proxyPools.length} active pools in order (resets on restart).`
                : `Random pool from ${proxyPools.length} active pools per request.`
              : "Uses the selected pool. Pick Round-robin or Random to rotate across all active pools."}
        >
          <select
            value={rotateStrategy}
            onChange={(e) => handleStrategyChange(e.target.value)}
            disabled={saving}
            className="h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-[13px] text-text outline-none focus:border-accent disabled:opacity-50 dark:border-border"
          >
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value} disabled={s.value !== "none" && !canRotate}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </section>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
