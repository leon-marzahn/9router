"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Icon,
  InlineStat,
  Kbd,
  ListGroup,
  ListRow,
  ProviderLogo,
  SearchInput,
  StatusDot,
  Tag,
  TopBarContent,
  cn,
  needsAttention,
} from "@/ui";
import { AddCustomEmbeddingModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useProviders } from "../../providers/useProviders";
import {
  DEFAULT_KIND,
  MEDIA_KINDS,
  buildMediaProviders,
  isLive,
  kindById,
  versionOf,
  type MediaCombo,
  type MediaEntry,
} from "./model";
import { MediaDetail } from "./MediaDetail";
import { MediaComboDetail } from "./MediaComboDetail";
import { MediaOverview } from "./MediaOverview";

type Notify = { getState: () => { error: (m: string) => void } };
const notify = () => (useNotificationStore as unknown as Notify).getState();

const AddEmbeddingModal = AddCustomEmbeddingModal as unknown as (p: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (node: { id: string }) => void;
}) => ReactNode;

const COMBO_BASE: Record<string, string> = { webSearch: "search-combo", webFetch: "fetch-combo" };

type Item = { type: "provider"; p: MediaEntry } | { type: "combo"; c: MediaCombo };
const itemId = (i: Item) => (i.type === "provider" ? `p:${i.p.id}` : `c:${i.c.id}`);

export function MediaWorkbench() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const kind = kindById(params.get("kind")) ?? kindById(DEFAULT_KIND)!;
  const selProvider = params.get("provider");
  const selCombo = params.get("combo");
  const { connections, nodes, loading, live, refresh, setConnectionActive } = useProviders();
  const [combos, setCombos] = useState<MediaCombo[] | null>(null);
  const [q, setQ] = useState("");
  const [addingEmbedding, setAddingEmbedding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback(
    (next: { kind?: string; provider?: string | null; combo?: string | null }) => {
      const sp = new URLSearchParams(params.toString());
      const set = (k: string, v: string | null | undefined) => {
        if (v === undefined) return;
        if (v) sp.set(k, v);
        else sp.delete(k);
      };
      set("kind", next.kind);
      set("provider", next.provider);
      set("combo", next.combo);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  const selectItem = useCallback(
    (i: Item | null) =>
      navigate(
        i?.type === "combo"
          ? { kind: kind.id, provider: null, combo: i.c.id }
          : { kind: kind.id, provider: i?.type === "provider" ? i.p.id : null, combo: null },
      ),
    [navigate, kind.id],
  );

  const loadCombos = useCallback(async () => {
    try {
      const res = await fetch("/api/combos", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCombos(((await res.json()).combos ?? []) as MediaCombo[]);
    } catch (e) {
      notify().error(`Couldn't load combos: ${(e as Error).message}`);
      setCombos((c) => c ?? []);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void loadCombos(), 0);
    return () => clearTimeout(t);
  }, [loadCombos]);

  // Old /media-providers/combo/[id] links only know the combo: take its kind from the combo.
  const combo = combos?.find((c) => c.id === selCombo) ?? null;
  useEffect(() => {
    if (combo?.kind && combo.kind !== params.get("kind") && kindById(combo.kind))
      navigate({ kind: combo.kind });
  }, [combo, params, navigate]);

  const providers = useMemo(
    () => buildMediaProviders(kind.id, connections, nodes),
    [kind.id, connections, nodes],
  );
  const kindCombos = (combos ?? []).filter((c) => c.kind === kind.id);
  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const visible = providers.filter((p) => match(p.name) || match(p.id));
  const groups: { title: string; tone?: "danger"; items: Item[] }[] = [
    {
      title: "Needs attention",
      tone: "danger" as const,
      items: visible.filter((p) => needsAttention(p.status)),
    },
    { title: "Connected", items: visible.filter((p) => !needsAttention(p.status) && isLive(p)) },
  ]
    .map((g) => ({ ...g, items: g.items.map((p): Item => ({ type: "provider", p })) }))
    .concat(
      kind.combos
        ? [
            {
              title: "Combos",
              items: kindCombos.filter((c) => match(c.name)).map((c) => ({ type: "combo", c })),
            },
          ]
        : [],
      [
        {
          title: "Available",
          items: visible
            .filter((p) => !isLive(p) && !needsAttention(p.status))
            .map((p) => ({ type: "provider", p })),
        },
      ],
    );
  const order = groups.flatMap((g) => g.items.map(itemId));
  const current = providers.find((p) => p.id === selProvider) ?? null;
  const selId = combo ? `c:${combo.id}` : current ? `p:${current.id}` : null;
  const hasSelection = !!(selProvider || selCombo);

  const createCombo = async () => {
    const base = COMBO_BASE[kind.id] || `${kind.id}-combo`;
    const taken = new Set((combos ?? []).map((c) => c.name));
    let name = base;
    for (let i = 1; taken.has(name); i++) name = `${base}-${i}`;
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models: [], kind: kind.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadCombos();
      navigate({ provider: null, combo: data.id });
    } catch (e) {
      notify().error(`Couldn't create the combo: ${(e as Error).message}`);
    }
  };

  // Keyboard: ↑/↓ or j/k move, / search, Esc back to overview
  useEffect(() => {
    const items = groups.flatMap((g) => g.items);
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("[aria-modal=true]")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = selId ? order.indexOf(selId) : -1;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        selectItem(items[Math.min(i + 1, items.length - 1)] ?? null);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        selectItem(items[Math.max(i - 1, 0)] ?? null);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") selectItem(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (selId)
      listRef.current
        ?.querySelector(`[data-id="${CSS.escape(selId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  const liveCount = providers.filter(isLive).length;
  const failing = providers.filter((p) => needsAttention(p.status));

  return (
    <>
      <TopBarContent>
        <InlineStat value={liveCount} label={`${kind.short.toLowerCase()} providers live`} />
        <InlineStat
          value={failing.length}
          label="failing"
          tone="danger"
          onClick={() => failing[0] && navigate({ provider: failing[0].id, combo: null })}
        />
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[11px]",
            live ? "text-text-muted" : "text-text-subtle",
          )}
          title={
            live ? "Updates stream in as they happen" : "Live updates disconnected — reconnecting"
          }
        >
          <StatusDot status={live ? "ok" : "pending"} live={live} />{" "}
          {live ? "Live" : "Reconnecting"}
        </span>
      </TopBarContent>

      <div className="flex min-h-0 flex-1">
        <section
          className={cn(
            "flex w-full shrink-0 flex-col border-r border-border bg-pane md:w-[330px]",
            hasSelection && "hidden md:flex",
          )}
        >
          <div className="space-y-2 p-3">
            <KindSwitch
              value={kind.id}
              onChange={(k) => {
                setQ("");
                navigate({ kind: k, provider: null, combo: null });
              }}
            />
            <SearchInput
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${kind.short.toLowerCase()} providers`}
              shortcut="/"
            />
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
            {loading ? (
              <ListSkeleton />
            ) : (
              <>
                {groups.map((g) =>
                  g.items.length === 0 && g.title !== "Combos" ? null : (
                    <ListGroup key={g.title} title={g.title} count={g.items.length} tone={g.tone}>
                      {g.items.map((i) =>
                        i.type === "provider" ? (
                          <MediaRow
                            key={i.p.id}
                            p={i.p}
                            active={selId === itemId(i)}
                            onClick={() => selectItem(i)}
                          />
                        ) : (
                          <ListRow
                            key={i.c.id}
                            id={itemId(i)}
                            active={selId === itemId(i)}
                            onClick={() => selectItem(i)}
                            leading={<Icon name="layers" size={20} className="text-accent" />}
                            title={<span className="font-mono">{i.c.name}</span>}
                            subtitle={`${i.c.models.length} provider${i.c.models.length === 1 ? "" : "s"}`}
                          />
                        ),
                      )}
                      {g.title === "Combos" && !needle && (
                        <AddRow onClick={createCombo}>New {kind.short.toLowerCase()} combo</AddRow>
                      )}
                    </ListGroup>
                  ),
                )}
                {kind.id === "embedding" && !needle && (
                  <AddRow onClick={() => setAddingEmbedding(true)}>Add custom embedding</AddRow>
                )}
                {order.length === 0 && needle && (
                  <div className="py-10 text-center text-text-muted">Nothing matches “{q}”.</div>
                )}
              </>
            )}
          </div>
          <div className="hidden gap-3 border-t border-border px-3 py-2 text-[11px] text-text-subtle md:flex">
            <span>
              <Kbd>↑↓</Kbd> move
            </span>
            <span>
              <Kbd>/</Kbd> search
            </span>
            <span>
              <Kbd>esc</Kbd> overview
            </span>
          </div>
        </section>

        <main className={cn("min-w-0 flex-1 overflow-y-auto", !hasSelection && "hidden md:block")}>
          {hasSelection && (
            <button
              type="button"
              onClick={() => selectItem(null)}
              className="flex items-center gap-1 px-4 pt-4 text-xs text-text-muted md:hidden"
            >
              <Icon name="arrow_back" size={16} /> {kind.label}
            </button>
          )}
          {combo ? (
            <MediaComboDetail
              key={combo.id}
              combo={combo}
              kind={kindById(combo.kind) ?? kind}
              connections={connections}
              onChanged={() => void loadCombos()}
              onDeleted={() => {
                void loadCombos();
                selectItem(null);
              }}
            />
          ) : current ? (
            <MediaDetail
              key={`${current.id}:${kind.id}`}
              p={current}
              kind={kind}
              onSetActive={setConnectionActive}
              onSwitchKind={(k) => navigate({ kind: k })}
              onCustomChanged={(deleted) => {
                void refresh();
                if (deleted) selectItem(null);
              }}
            />
          ) : loading || (selCombo && combos === null) ? null : hasSelection ? (
            <div className="px-6 py-16 text-center text-text-muted">
              {selCombo
                ? "This combo no longer exists."
                : `No ${kind.label} provider “${selProvider}”.`}
            </div>
          ) : (
            <MediaOverview
              kind={kind}
              providers={providers}
              combos={kindCombos}
              onSelect={(id) => navigate({ provider: id, combo: null })}
              onSelectCombo={(id) => navigate({ provider: null, combo: id })}
              onCreateCombo={kind.combos ? createCombo : undefined}
            />
          )}
        </main>
      </div>

      {kind.id === "embedding" && (
        <AddEmbeddingModal
          isOpen={addingEmbedding}
          onClose={() => setAddingEmbedding(false)}
          onCreated={async (node) => {
            setAddingEmbedding(false);
            await refresh();
            navigate({ provider: node.id, combo: null });
          }}
        />
      )}
    </>
  );
}

/** Media kinds as a compact grid (10 kinds don't fit a Segmented). */
function KindSwitch({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Media kind" className="grid grid-cols-3 gap-1">
      {MEDIA_KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          role="radio"
          aria-checked={value === k.id}
          onClick={() => onChange(k.id)}
          title={k.label}
          className={cn(
            "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] transition-colors",
            value === k.id
              ? "bg-accent-soft font-medium text-accent-text ring-1 ring-accent-ring"
              : "text-text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <Icon name={k.icon} size={17} filled={value === k.id} className="shrink-0" />
          <span className="w-full truncate text-center">{k.short}</span>
        </button>
      ))}
    </div>
  );
}

function AddRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong py-2 text-xs text-text-muted hover:border-accent hover:text-accent-text dark:border-border"
    >
      {children} <Icon name="add" size={16} />
    </button>
  );
}

function MediaRow({ p, active, onClick }: { p: MediaEntry; active: boolean; onClick: () => void }) {
  return (
    <ListRow
      id={`p:${p.id}`}
      active={active}
      onClick={onClick}
      version={versionOf(p)}
      leading={
        <span className="relative shrink-0">
          <ProviderLogo
            providerId={p.id}
            src={p.iconSrc}
            name={p.name}
            color={p.color}
            fallbackText={p.textIcon}
            size={22}
            className={p.status === "none" ? "opacity-50 grayscale" : ""}
          />
          <StatusDot
            status={p.status}
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-pane"
          />
        </span>
      }
      title={p.name}
      subtitle={
        p.noAuth
          ? "No key needed"
          : p.stats.total > 0
            ? `${p.stats.connected}/${p.stats.total} accounts`
            : p.custom
              ? "Custom endpoint"
              : "Not connected"
      }
      trailing={
        p.stats.errorCode ? (
          <Tag tone="danger" mono>
            {p.stats.errorCode}
          </Tag>
        ) : p.custom ? (
          <Tag>Custom</Tag>
        ) : undefined
      }
    />
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 pt-2">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2.5 py-2">
          <div className="size-[22px] animate-pulse rounded-md bg-surface-2" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
            <div className="h-2.5 w-20 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
