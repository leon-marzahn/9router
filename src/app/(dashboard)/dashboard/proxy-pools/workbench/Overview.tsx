"use client";

import { useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  Eyebrow,
  Panel,
  StatGrid,
  StatusDot,
  Tag,
  needsAttention,
} from "@/ui";
import { cn } from "@/ui/cn";
import { RELAY_LABEL, poolStatus, type ProxyPool } from "./pools";
import type { ProxyPoolsApi } from "./useProxyPools";

/** Summary, stats, and the bulk table (select → activate / deactivate / test / delete). */
export function Overview({
  api,
  onOpen,
  onAdd,
}: {
  api: ProxyPoolsApi;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const list = api.list;
  const [picked, setPicked] = useState<string[]>([]);
  const selected = picked.filter((id) => list.some((p) => p.id === id));
  const all = list.length > 0 && selected.length === list.length;
  const busy = api.bulkBusy || !!api.health;
  const active = list.filter((p) => p.isActive).length;
  const failing = list.filter((p) => needsAttention(poolStatus(p))).length;
  const bound = list.reduce((n, p) => n + (p.boundConnectionCount || 0), 0);
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header>
        <h1 className="font-display text-3xl tracking-tight">Proxy Pools</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-text-muted">
          <b className="font-medium text-text">
            {active} active {active === 1 ? "proxy" : "proxies"}
          </b>{" "}
          of {list.length}, used by <b className="font-medium text-text">{bound} connections</b>
          {failing ? ` · ${failing} unreachable` : ""}. Assign a pool to a connection on its
          provider page.
        </p>
      </header>

      {list.length === 0 ? (
        <EmptyState
          icon="lan"
          action={
            <Button variant="primary" icon="add" onClick={onAdd}>
              Add proxy pool
            </Button>
          }
        >
          Create a proxy pool entry, then assign it to connections.
        </EmptyState>
      ) : (
        <>
          <StatGrid
            items={[
              { label: "Pools", value: list.length },
              { label: "Active", value: active },
              { label: "Unreachable", value: failing, tone: failing ? "danger" : undefined },
              { label: "Bound connections", value: bound },
            ]}
          />

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Eyebrow>{selected.length ? `${selected.length} selected` : "All pools"}</Eyebrow>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="health_and_safety"
                  loading={!!api.health}
                  disabled={busy}
                  onClick={() => void api.healthCheck(selected)}
                >
                  {api.health
                    ? `Checking ${api.health.current}/${api.health.total}`
                    : selected.length
                      ? "Health check selected"
                      : "Health check all"}
                </Button>
                {selected.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="toggle_on"
                      disabled={busy}
                      onClick={() => void api.bulkSetActive(selected, true)}
                    >
                      Activate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="toggle_off"
                      disabled={busy}
                      onClick={() => void api.bulkSetActive(selected, false)}
                    >
                      Deactivate
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="delete"
                      disabled={busy}
                      onClick={() => api.bulkDelete(selected, () => setPicked([]))}
                    >
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPicked([])}>
                      Clear
                    </Button>
                  </>
                )}
              </div>
            </div>
            <Panel className="divide-y divide-border">
              <Checkbox
                className="flex gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-text-subtle"
                checked={all}
                onChange={() => setPicked(all ? [] : list.map((p) => p.id))}
                label={all ? "Unselect all" : "Select all"}
              />
              {list.map((p) => (
                <PoolLine
                  key={p.id}
                  pool={p}
                  checked={selected.includes(p.id)}
                  onCheck={() => toggle(p.id)}
                  onOpen={() => onOpen(p.id)}
                />
              ))}
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}

function PoolLine({
  pool: p,
  checked,
  onCheck,
  onOpen,
}: {
  pool: ProxyPool;
  checked: boolean;
  onCheck: () => void;
  onOpen: () => void;
}) {
  const status = poolStatus(p);
  return (
    <div className={cn("flex items-center gap-3 px-4 py-2.5", checked && "bg-accent-soft")}>
      <Checkbox aria-label={`Select ${p.name}`} checked={checked} onChange={onCheck} />
      <StatusDot status={status} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left max-md:min-h-10">
        <span className="block truncate text-[13px] hover:underline">{p.name}</span>
        <span className="block truncate font-mono text-[11px] text-text-muted">{p.proxyUrl}</span>
      </button>
      {p.type && p.type !== "http" && (
        <Tag className="hidden sm:inline-flex">{RELAY_LABEL[p.type]}</Tag>
      )}
      <Tag>{p.boundConnectionCount || 0} bound</Tag>
    </div>
  );
}
