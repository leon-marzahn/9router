"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  ListSkeleton,
  Note,
  SearchInput,
  Segmented,
  Skeleton,
  Tag,
  cn,
} from "@/ui";

const REGISTRY_ENDPOINT = "/api/cli-tools/cowork-mcp-registry";
const TOOLS_ENDPOINT = "/api/cli-tools/cowork-mcp-tools";

export type MarketServer = {
  name: string;
  slug?: string;
  title: string;
  description?: string;
  url: string;
  transport?: string;
  oauth?: boolean;
  toolNames?: string[];
  toolCount?: number;
  iconUrl?: string | null;
};

export type MarketPlugin = {
  name: string;
  title?: string;
  description?: string;
  url?: string;
  transport?: string;
  oauth?: boolean;
  toolNames?: string[];
};

type Probe = { tools: { name: string }[]; requiresAuth?: boolean; error?: string };
type Filter = "all" | "authless" | "oauth";

const keyOf = (s: MarketServer) => s.slug || s.name;

function ServerIcon({ server, size = 28 }: { server: MarketServer; size?: number }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size };
  if (server.iconUrl && !broken)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={server.iconUrl}
        alt=""
        style={box}
        className="shrink-0 rounded-lg object-contain"
        onError={() => setBroken(true)}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    );
  return (
    <span style={box} className="grid shrink-0 place-items-center rounded-lg bg-surface-2 text-text-muted">
      <Icon name="extension" size={Math.round(size * 0.6)} />
    </span>
  );
}

/** Browse the MCP registry and add servers (with a chosen subset of tools) to Cowork. */
export function McpMarketplace({
  open,
  onClose,
  onAdd,
  addedNames = [],
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (p: MarketPlugin) => void;
  addedNames?: string[];
}) {
  const [servers, setServers] = useState<MarketServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [selUrl, setSelUrl] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [toolSel, setToolSel] = useState<Record<string, Record<string, boolean>>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || servers.length > 0) return;
    setLoading(true);
    fetch(REGISTRY_ENDPOINT)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setServers(d.servers || []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addedSet = useMemo(() => new Set(addedNames), [addedNames]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return servers.filter((s) => {
      if (filter === "authless" && s.oauth) return false;
      if (filter === "oauth" && !s.oauth) return false;
      if (!q) return true;
      return (
        (s.title || "").toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.name || "").toLowerCase().includes(q)
      );
    });
  }, [servers, search, filter]);

  const current = servers.find((s) => s.url === selUrl) ?? null;

  const fetchTools = async (server: MarketServer) => {
    if (probes[server.url]) return;
    setProbing((p) => ({ ...p, [server.url]: true }));
    try {
      const r = await fetch(TOOLS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: server.url }),
      });
      const d = await r.json();
      const tools: { name: string }[] = d.tools || [];
      const fallback = Array.isArray(server.toolNames) ? server.toolNames : [];
      const names = tools.length > 0 ? tools.map((t) => t.name) : fallback;
      setProbes((p) => ({ ...p, [server.url]: { tools, requiresAuth: !!d.requiresAuth, error: d.error } }));
      // Default: all checked
      setToolSel((p) => ({ ...p, [server.url]: Object.fromEntries(names.map((t) => [t, true])) }));
    } catch (e) {
      setProbes((p) => ({ ...p, [server.url]: { tools: [], error: (e as Error).message } }));
    } finally {
      setProbing((p) => ({ ...p, [server.url]: false }));
    }
  };

  const select = (s: MarketServer) => {
    setSelUrl(s.url);
    if (!addedSet.has(keyOf(s))) void fetchTools(s);
  };

  const toggleTool = (url: string, tool: string) =>
    setToolSel((prev) => ({ ...prev, [url]: { ...prev[url], [tool]: !prev[url]?.[tool] } }));

  const setAllTools = (url: string, value: boolean) =>
    setToolSel((prev) => ({
      ...prev,
      [url]: Object.fromEntries(Object.keys(prev[url] || {}).map((t) => [t, value])),
    }));

  const confirmAdd = (s: MarketServer) => {
    const sel = toolSel[s.url] || {};
    onAdd({
      name: keyOf(s),
      title: s.title,
      description: s.description,
      url: s.url,
      transport: s.transport,
      oauth: s.oauth,
      toolNames: Object.keys(sel).filter((t) => sel[t]),
    });
    setSelUrl(null);
  };

  const close = () => {
    setSelUrl(null);
    onClose();
  };

  const available = filtered.filter((s) => !addedSet.has(keyOf(s)));
  const added = filtered.filter((s) => addedSet.has(keyOf(s)));

  const row = (s: MarketServer) => (
    <ListRow
      key={s.url}
      id={s.url}
      leading={<ServerIcon server={s} />}
      title={s.title}
      subtitle={s.description || s.url}
      onClick={() => select(s)}
      trailing={
        <span className="flex shrink-0 items-center gap-1.5">
          {!!s.toolCount && <span className="text-[11px] tabular-nums text-text-subtle">{s.toolCount} tools</span>}
          {s.oauth ? <Tag tone="warning">OAuth</Tag> : <Tag tone="success">Authless</Tag>}
        </span>
      }
    />
  );

  const list = (
    <div className="space-y-3">
      <div className="space-y-2">
        <SearchInput
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or description"
          aria-label="Search MCP servers"
        />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "authless", label: "Authless" },
            { value: "oauth", label: "OAuth" },
          ]}
        />
      </div>
      {error && <Note tone="danger">{error}</Note>}
      {loading ? (
        <ListSkeleton rows={6} />
      ) : filtered.length === 0 ? (
        servers.length === 0 && !error ? (
          <EmptyState icon="storefront">The registry has no servers right now.</EmptyState>
        ) : (
          <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">No servers match the filter.</p>
        )
      ) : (
        <div className="-mx-2.5">
          {available.length > 0 && (
            <ListGroup title="Available" count={available.length}>
              {available.map(row)}
            </ListGroup>
          )}
          {added.length > 0 && (
            <ListGroup title="Added" count={added.length}>
              {added.map(row)}
            </ListGroup>
          )}
        </div>
      )}
      {!loading && servers.length > 0 && (
        <p className="text-right text-[11px] tabular-nums text-text-subtle">
          {filtered.length} of {servers.length} servers
        </p>
      )}
    </div>
  );

  let detail = null;
  let footer = null;
  if (current) {
    const isAdded = addedSet.has(keyOf(current));
    const probe = probes[current.url];
    const isProbing = !!probing[current.url];
    const sel = toolSel[current.url] || {};
    const toolKeys = Object.keys(sel);
    const selectedCount = toolKeys.filter((t) => sel[t]).length;
    detail = (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setSelUrl(null)}
          className="-ml-1 flex items-center gap-1 rounded-lg px-1 text-[13px] text-text-muted transition-colors hover:text-text"
        >
          <Icon name="arrow_back" size={16} />
          All servers
        </button>
        <div className="flex items-start gap-3">
          <ServerIcon server={current} size={44} />
          <div className="min-w-0 flex-1">
            <div className="font-display text-2xl leading-tight tracking-tight">{current.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {current.oauth ? <Tag tone="warning">OAuth</Tag> : <Tag tone="success">Authless</Tag>}
              {current.transport && <Tag mono>{current.transport}</Tag>}
              {isAdded && <Tag tone="accent">Added</Tag>}
            </div>
          </div>
        </div>
        {current.description && <p className="text-text-muted">{current.description}</p>}
        <div className="flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]">
          <span className="min-w-0 flex-1 truncate">{current.url}</span>
        </div>
        {isAdded ? (
          <Note tone="success">Already added. Remove it from the MCP servers list to change its tools.</Note>
        ) : isProbing ? (
          <div className="space-y-2" aria-busy="true">
            <div className="text-[12px] text-text-muted">Probing server for tools…</div>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          </div>
        ) : (
          <>
            {probe?.requiresAuth && (
              <Note tone="warning">
                OAuth required. Add it now and sign in after you connect; its tools are discovered on the first connect.
              </Note>
            )}
            {probe?.error && !probe.requiresAuth && <Note tone="danger">Probe failed: {probe.error}</Note>}
            {toolKeys.length === 0 && !probe?.requiresAuth && !probe?.error && (
              <p className="text-[12px] text-text-muted">The server advertises no tools.</p>
            )}
            {toolKeys.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] tabular-nums text-text-muted">
                    {selectedCount}/{toolKeys.length} tools enabled
                  </span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setAllTools(current.url, true)}>
                      All
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAllTools(current.url, false)}>
                      None
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 rounded-lg border border-border p-2 sm:grid-cols-2">
                  {toolKeys.map((t) => (
                    <label
                      key={t}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] transition-colors hover:bg-surface-2",
                        !sel[t] && "text-text-muted",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={!!sel[t]}
                        onChange={() => toggleTool(current.url, t)}
                        className="size-3.5 accent-accent"
                      />
                      <span className="truncate font-mono">{t}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setSelUrl(null)}>
          Back
        </Button>
        {!isAdded && (
          <Button variant="primary" icon="add" disabled={isProbing} onClick={() => confirmAdd(current)}>
            Add server
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="MCP marketplace"
      description="Add servers from the MCP registry to Cowork."
      size="xl"
      footer={footer}
    >
      {detail ?? list}
    </Dialog>
  );
}
