"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  Button,
  ConfirmDialog,
  ListAddRow,
  ListGroup,
  ListRow,
  ListSkeleton,
  MenuItem,
  Popover,
  SearchInput,
  StatusDot,
  TopBarActions,
  WorkbenchDetail,
  WorkbenchList,
  WorkbenchOverviewRow,
  needsAttention,
  useListKeyboard,
} from "@/ui";
import {
  BatchImportDialog,
  NewPoolDialog,
  RELAYS,
  RELAY_ORDER,
  RelayDialog,
  type RelayKind,
} from "./dialogs";
import { Overview } from "./Overview";
import { PoolDetail } from "./PoolDetail";
import { RELAY_LABEL, poolStatus, type ProxyPool } from "./pools";
import { useProxyPools } from "./useProxyPools";

const PATH = "/dashboard/proxy-pools";

type Open = { kind: "new" } | { kind: "import" } | { kind: "relay"; relay: RelayKind } | null;

export function ProxyPoolsWorkbench() {
  const api = useProxyPools();
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("pool");
  const current = api.list.find((p) => p.id === sel);
  // Mobile only: the overview as its own screen (desktop shows it with nothing selected)
  const overview = !current && params.get("view") === "overview";
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Open>(null);
  const [relayMenu, setRelayMenu] = useState(false);
  const relayRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? api.list.filter(
        (p) => p.name.toLowerCase().includes(needle) || p.proxyUrl.toLowerCase().includes(needle),
      )
    : api.list;
  const failing = shown.filter((p) => needsAttention(poolStatus(p)));
  const rest = shown.filter((p) => !needsAttention(poolStatus(p)));
  const order = [...failing, ...rest].map((p) => p.id);

  const select = (id: string | null) =>
    router.replace(id ? `${PATH}?pool=${encodeURIComponent(id)}` : PATH, { scroll: false });
  const openOverview = () => router.replace(`${PATH}?view=overview`, { scroll: false });

  useListKeyboard({ order, selected: current?.id ?? null, onSelect: select, searchRef });

  const row = (p: ProxyPool) => {
    const status = poolStatus(p);
    const kind = p.type && p.type !== "http" ? RELAY_LABEL[p.type] : null;
    return (
      <ListRow
        key={p.id}
        id={p.id}
        active={p.id === sel}
        onClick={() => select(p.id)}
        leading={<StatusDot status={status} live={api.testingId === p.id} />}
        title={p.name}
        subtitle={
          <span className="font-mono">
            {kind ? `${kind} · ` : ""}
            {p.proxyUrl}
          </span>
        }
        trailing={
          p.boundConnectionCount ? (
            <span className="text-[11px] text-text-subtle tabular-nums">
              {p.boundConnectionCount}
            </span>
          ) : null
        }
        version={`${status}:${p.boundConnectionCount ?? 0}`}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      <TopBarActions>
        <Button
          ref={relayRef}
          size="sm"
          variant="secondary"
          icon="rocket_launch"
          onClick={() => setRelayMenu(true)}
        >
          <span className="hidden sm:inline">Deploy relay</span>
        </Button>
        <Popover
          open={relayMenu}
          onClose={() => setRelayMenu(false)}
          anchorRef={relayRef}
          side="bottom-end"
          className="w-52 py-1"
        >
          {RELAY_ORDER.map((k) => (
            <MenuItem
              key={k}
              icon={RELAYS[k].icon}
              onClick={() => {
                setRelayMenu(false);
                setOpen({ kind: "relay", relay: k });
              }}
            >
              {RELAYS[k].label}
            </MenuItem>
          ))}
        </Popover>
        <Button
          size="sm"
          variant="secondary"
          icon="upload"
          onClick={() => setOpen({ kind: "import" })}
        >
          <span className="hidden sm:inline">Batch import</span>
        </Button>
      </TopBarActions>

      <WorkbenchList
        selected={current?.id ?? null}
        detailOpen={!!current || overview}
        hints={[
          ["↑↓", "move"],
          ["/", "search"],
          ["esc", "overview"],
        ]}
        header={
          <div className="flex items-center gap-2">
            <SearchInput
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search proxies"
              shortcut="/"
              className="min-w-0 flex-1"
            />
            <Button size="sm" icon="add" onClick={() => setOpen({ kind: "new" })}>
              New
            </Button>
          </div>
        }
      >
        {!api.pools ? (
          <ListSkeleton rows={5} />
        ) : (
          <>
            <WorkbenchOverviewRow
              icon="lan"
              subtitle="Stats, health check, bulk actions"
              onClick={openOverview}
            />
            {failing.length > 0 && (
              <ListGroup title="Needs attention" count={failing.length} tone="danger">
                {failing.map(row)}
              </ListGroup>
            )}
            {rest.length > 0 && (
              <ListGroup title="Proxies" count={rest.length}>
                {rest.map(row)}
              </ListGroup>
            )}
            {shown.length === 0 && (
              <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
                {needle ? "No proxies match." : "No proxy pools yet."}
              </p>
            )}
            <ListAddRow onClick={() => setOpen({ kind: "new" })}>Add proxy pool</ListAddRow>
          </>
        )}
      </WorkbenchList>

      <WorkbenchDetail
        detailOpen={!!current || overview}
        backLabel="All proxies"
        onBack={() => select(null)}
      >
        {current ? (
          <PoolDetail
            key={`${current.id}:${current.updatedAt ?? ""}`}
            pool={current}
            api={api}
            onDeleted={() => select(null)}
          />
        ) : (
          <Overview api={api} onOpen={select} onAdd={() => setOpen({ kind: "new" })} />
        )}
      </WorkbenchDetail>

      {open?.kind === "new" && (
        <NewPoolDialog api={api} onClose={() => setOpen(null)} onCreated={select} />
      )}
      {open?.kind === "import" && <BatchImportDialog api={api} onClose={() => setOpen(null)} />}
      {open?.kind === "relay" && (
        <RelayDialog api={api} initialKind={open.relay} onClose={() => setOpen(null)} />
      )}
      <ConfirmDialog
        open={!!api.confirm}
        onClose={() => api.setConfirm(null)}
        onConfirm={() => void api.confirm?.onConfirm()}
        title={api.confirm?.title ?? "Confirm"}
        message={<span className="whitespace-pre-line">{api.confirm?.message}</span>}
        confirmText={api.confirm?.confirmText}
        loading={api.bulkBusy}
      />
    </div>
  );
}
