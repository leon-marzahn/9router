// Quota page ("workbench"): accounts grouped by provider on the left, every
// limit visible per row. The right pane shows when limits come back (reset
// timeline) and per-provider *capacity*: for each limit type, one bar made of
// one segment per account, filled to what that account has left — "how much
// can I still send to Claude right now". Selecting a provider or an account
// narrows the same views to it.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Panel,
  Popover,
  ProviderLogo,
  SearchInput,
  ListGroup,
  ListRow,
  ListSkeleton,
  Segmented,
  Skeleton,
  StatusDot,
  Tag,
  TopBarActions,
  ConfirmDialog,
  WorkbenchDetail,
  WorkbenchList,
  useListKeyboard,
} from "@/ui";
import { STATUS_ORDER } from "@/ui/status";
import { cn } from "@/ui/cn";
import { AccountActions, AccountStatus, WindowBar, statusWord, type Actions } from "./parts";
import { ResetTimeline, type Span } from "./ResetTimeline";
import {
  EXHAUSTED,
  LOW,
  barTone,
  pctText,
  providerName,
  sortAccounts,
  untilText,
  useNow,
  windowLabel,
  type QuotaAccount,
} from "./useQuota";

type Scope = "all" | "low" | "off";
type Sel = { kind: "provider" | "account"; id: string } | null;

const LAST_VIEW_KEY = "regent.quotaUrl.v1";
const RANGE_TO_SPAN: Record<string, Span> = { "6h": 6, "24h": 24, "7d": 168 };
const SPAN_TO_RANGE: Record<Span, string> = { 6: "6h", 24: "24h", 168: "7d" };

interface Group {
  provider: string;
  accounts: QuotaAccount[];
  status: QuotaAccount["status"];
}

function groupsOf(accounts: QuotaAccount[]): Group[] {
  const by = new Map<string, QuotaAccount[]>();
  for (const a of sortAccounts(accounts)) by.set(a.provider, [...(by.get(a.provider) ?? []), a]);
  return [...by.entries()]
    .map(([provider, list]) => {
      const live = list.filter((a) => a.isActive);
      const status = (live.length ? live : list).reduce<QuotaAccount["status"]>(
        (s, a) => (STATUS_ORDER[a.status] < STATUS_ORDER[s] ? a.status : s),
        "none",
      );
      return { provider, accounts: list, status };
    })
    .sort(
      (x, y) =>
        STATUS_ORDER[x.status] - STATUS_ORDER[y.status] ||
        providerName(x.provider).localeCompare(providerName(y.provider)),
    );
}

export function QuotaWorkbench({
  accounts,
  actions,
  onRefreshAll,
  loading = false,
}: {
  accounts: QuotaAccount[];
  actions: Actions;
  onRefreshAll: () => Promise<void>;
  /** No account list yet: keep the real frame, shimmer only where data goes. */
  loading?: boolean;
}) {
  const now = useNow();
  // View state lives in the URL so it can be linked and survives reloads:
  // ?provider=claude | ?account=<id>, ?range=6h|24h|7d, ?view=overview (mobile).
  // Opening the page bare (e.g. from the sidebar) restores the last one.
  const searchParams = useSearchParams();
  const router = useRouter();
  const qs = searchParams.toString();
  const urlProvider = searchParams.get("provider");
  const urlAccount = searchParams.get("account");
  const sel: Sel = urlAccount
    ? { kind: "account", id: urlAccount }
    : urlProvider
      ? { kind: "provider", id: urlProvider }
      : null;
  const span: Span = RANGE_TO_SPAN[searchParams.get("range") ?? ""] ?? 24;
  const mobileView = searchParams.get("view") === "overview" ? "overview" : "accounts";
  const update = (edit: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(qs);
    edit(params);
    const next = params.toString();
    router.replace(next ? `/dashboard/quota?${next}` : "/dashboard/quota", { scroll: false });
  };
  const setSel = (next: Sel) => {
    // The hovered row may unmount on navigation without a mouseleave; clear it.
    setHover(null);
    update((p) => {
      p.delete("provider");
      p.delete("account");
      if (next) p.set(next.kind === "provider" ? "provider" : "account", next.id);
    });
  };
  const setSpan = (next: Span) =>
    update((p) => {
      if (next === 24) p.delete("range");
      else p.set("range", SPAN_TO_RANGE[next]);
    });
  const setMobileView = (v: "accounts" | "overview") =>
    update((p) => {
      if (v === "overview") p.set("view", "overview");
      else p.delete("view");
    });
  const restored = useRef(false);
  useEffect(() => {
    try {
      if (!restored.current) {
        restored.current = true;
        const last = localStorage.getItem(LAST_VIEW_KEY);
        if (!qs && last) {
          router.replace(`/dashboard/quota?${last}`, { scroll: false });
          return;
        }
      }
      localStorage.setItem(LAST_VIEW_KEY, qs);
    } catch {
      // Storage blocked: the URL still works, it just isn't remembered.
    }
  }, [qs, router]);
  const [scope, setScope] = useState<Scope>("all");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  const filtered = accounts
    .filter((a) => `${a.label} ${providerName(a.provider)}`.toLowerCase().includes(q.toLowerCase()))
    .filter((a) =>
      scope === "low"
        ? a.isActive && (a.status === "error" || a.status === "degraded")
        : scope === "off"
          ? !a.isActive
          : true,
    );
  const groups = useMemo(() => groupsOf(filtered), [filtered]);
  const allGroups = useMemo(() => groupsOf(accounts), [accounts]);

  const selAccount =
    sel?.kind === "account" ? (accounts.find((a) => a.id === sel.id) ?? null) : null;
  const selProvider = sel?.kind === "provider" ? sel.id : (selAccount?.provider ?? null);
  const overview = !sel && mobileView === "overview";

  // List rows: each provider group starts with its summary row, then its accounts.
  const rowId = (s: NonNullable<Sel>) => `${s.kind === "provider" ? "p" : "a"}:${s.id}`;
  const order = groups.flatMap((g) => [
    rowId({ kind: "provider", id: g.provider }),
    ...g.accounts.map((a) => rowId({ kind: "account", id: a.id })),
  ]);
  const selRow = sel ? rowId(sel) : null;
  const pickRow = (id: string | null) =>
    setSel(id ? { kind: id.startsWith("p:") ? "provider" : "account", id: id.slice(2) } : null);
  useListKeyboard({ order, selected: selRow, onSelect: pickRow, searchRef });

  return (
    <div className="flex min-h-0 flex-1">
      <TopBarActions>
        <BulkMenu accounts={accounts} actions={actions} />
        <RefreshAll onRefresh={onRefreshAll} />
      </TopBarActions>

      <WorkbenchList
        // The mobile overview counts as a selection so the list steps aside for it.
        selected={selRow ?? (overview ? "overview" : null)}
        hints={[
          ["↑↓", "move"],
          ["/", "search"],
          ["esc", "overview"],
        ]}
        header={
          <>
            <MobileSwitch value={mobileView} onChange={setMobileView} />
            <SearchInput
              ref={searchRef}
              placeholder="Search accounts or providers"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              shortcut="/"
            />
            <Segmented<Scope>
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: `All · ${accounts.length}` },
                { value: "low", label: "Running low" },
                { value: "off", label: "Turned off" },
              ]}
            />
          </>
        }
      >
        {loading && !groups.length ? (
          <ListSkeleton />
        ) : !groups.length ? (
          <p className="px-2.5 py-6 text-[13px] text-text-muted">No accounts match.</p>
        ) : (
          groups.map((g) => (
            <ListGroup key={g.provider} title={providerName(g.provider)} count={g.accounts.length}>
              <ListRow
                id={rowId({ kind: "provider", id: g.provider })}
                active={sel?.kind === "provider" && sel.id === g.provider}
                onClick={() => setSel({ kind: "provider", id: g.provider })}
                leading={
                  <ProviderLogo providerId={g.provider} name={providerName(g.provider)} size={22} />
                }
                title="Capacity and resets"
                subtitle={`${g.accounts.filter((a) => a.isActive).length} of ${g.accounts.length} routing`}
                trailing={<StatusDot status={g.status} />}
              />
              {g.accounts.map((a) => (
                <AccountRow
                  key={a.id}
                  id={rowId({ kind: "account", id: a.id })}
                  a={a}
                  now={now}
                  active={sel?.kind === "account" && sel.id === a.id}
                  hovered={hover === a.id}
                  onClick={() => setSel({ kind: "account", id: a.id })}
                />
              ))}
            </ListGroup>
          ))
        )}
      </WorkbenchList>

      <WorkbenchDetail
        selected={!!sel || overview}
        backLabel={
          sel?.kind === "account" && selProvider
            ? providerName(selProvider)
            : sel
              ? "All accounts"
              : "Accounts"
        }
        onBack={() =>
          sel?.kind === "account" && selProvider
            ? setSel({ kind: "provider", id: selProvider })
            : sel
              ? setSel(null)
              : setMobileView("accounts")
        }
      >
        <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-8">
          {selAccount ? (
            <AccountDetail
              a={selAccount}
              siblings={accounts.filter(
                (x) => x.provider === selAccount.provider && x.id !== selAccount.id,
              )}
              now={now}
              span={span}
              setSpan={setSpan}
              actions={actions}
              onPick={(id) => setSel({ kind: "account", id })}
            />
          ) : selProvider && allGroups.some((g) => g.provider === selProvider) ? (
            <ProviderDetail
              group={allGroups.find((g) => g.provider === selProvider)!}
              now={now}
              span={span}
              setSpan={setSpan}
              hover={hover}
              setHover={setHover}
              onPick={(id) => setSel({ kind: "account", id })}
              actions={actions}
            />
          ) : sel && !loading ? (
            <EmptyState icon="search_off">
              This {sel.kind} isn&rsquo;t tracked any more. Pick another from the list.
            </EmptyState>
          ) : (
            <>
              <div>
                <h1 className="font-display text-3xl">Quota</h1>
                <p className="mt-1 text-[13px] text-text-muted">
                  {loading ? (
                    "Reading limits from your providers…"
                  ) : (
                    <>
                      <strong className="font-medium text-text">
                        {accounts.filter((a) => a.isActive).length} of {plural(accounts.length)}
                      </strong>{" "}
                      routing across {allGroups.length} provider
                      {allGroups.length === 1 ? "" : "s"}
                    </>
                  )}
                </p>
              </div>
              <ResetTimeline
                accounts={accounts}
                now={now}
                span={span}
                setSpan={setSpan}
                highlight={hover}
                onHover={setHover}
                onPick={(id) => setSel({ kind: "account", id })}
                title="Coming back"
                loading={
                  loading || accounts.some((a) => a.isActive && a.loading && !a.windows.length)
                }
              />
              <section className="space-y-3">
                <div>
                  <h2 className="font-display text-xl">Capacity left</h2>
                  <p className="text-xs text-text-muted">
                    One segment per account, filled to what it has left. Turned-off accounts
                    aren&rsquo;t counted.
                  </p>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  {loading && !allGroups.length && [0, 1].map((i) => <CapacitySkeleton key={i} />)}
                  {allGroups.map((g) => (
                    <CapacityCard
                      key={g.provider}
                      group={g}
                      now={now}
                      onOpen={() => setSel({ kind: "provider", id: g.provider })}
                      hover={hover}
                      setHover={setHover}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </WorkbenchDetail>
    </div>
  );
}

/** List row: account name + every window as a labeled mini bar. */
function AccountRow({
  id,
  a,
  now,
  active,
  hovered,
  onClick,
}: {
  id: string;
  a: QuotaAccount;
  now: number;
  active: boolean;
  hovered: boolean;
  onClick: () => void;
}) {
  const shown = a.windows.slice(0, 3);
  return (
    <ListRow
      id={id}
      active={active}
      onClick={onClick}
      version={a.worst}
      className={cn(hovered && !active && "bg-surface-2", !a.isActive && "opacity-55")}
      leading={
        <span className="grid size-[22px] shrink-0 place-items-center">
          <StatusDot status={a.status} />
        </span>
      }
      title={
        <>
          {a.label}
          {a.plan && <span className="ml-2 text-[10px] text-text-subtle">{a.plan}</span>}
        </>
      }
      trailing={
        a.nextReset && (
          <span className="shrink-0 self-start text-[10px] tabular-nums text-text-subtle">
            ↻ {untilText(a.nextReset, now)}
          </span>
        )
      }
      subtitle={
        a.error ? (
          <span className="text-danger-text">{a.error}</span>
        ) : a.loading && !shown.length ? (
          "Reading limits…"
        ) : shown.length ? (
          <span
            className={cn(
              "mt-1 grid gap-x-3 gap-y-1 transition-opacity duration-300",
              a.loading && "opacity-60",
            )}
            style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
          >
            {shown.map((w) => (
              <span key={w.name} className="min-w-0">
                <span className="flex justify-between gap-1 text-[10px]">
                  <span className="truncate">{shortName(w.name)}</span>
                  <span
                    className={cn(
                      "tabular-nums text-text",
                      w.remaining != null && w.remaining <= EXHAUSTED && "text-danger-text",
                    )}
                  >
                    {pctText(w)}
                  </span>
                </span>
                <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-surface-3">
                  <span
                    className={cn("block h-full rounded-full", barTone(w.remaining))}
                    style={{
                      width: w.remaining == null ? "100%" : `${Math.max(3, w.remaining)}%`,
                      opacity: w.remaining == null ? 0.35 : 1,
                    }}
                  />
                </span>
              </span>
            ))}
          </span>
        ) : (
          "No limits reported"
        )
      }
    />
  );
}

const shortName = (n: string) =>
  windowLabel(n)
    .replace(/^Session · /, "")
    .replace(/^Weekly · 7d$/, "7d")
    .replace(/^Weekly (\w+) · 7d$/, "$1 7d")
    .replace(/^Premium interactions$/, "Premium");

/** Per-provider capacity: one bar per window type, one segment per active account. */
function Capacity({
  group,
  now,
  hover,
  setHover,
  onPick,
}: {
  group: Group;
  now: number;
  hover?: string | null;
  setHover?: (id: string | null) => void;
  onPick?: (id: string) => void;
}) {
  const live = group.accounts.filter((a) => a.isActive && !a.error);
  const kinds = useMemo(() => {
    const m = new Map<
      string,
      { label: string; cells: { a: QuotaAccount; w: QuotaAccount["windows"][number] }[] }
    >();
    for (const a of live)
      for (const w of a.windows) {
        const k = windowLabel(w.name);
        if (!m.has(k)) m.set(k, { label: k, cells: [] });
        m.get(k)!.cells.push({ a, w });
      }
    return [...m.values()];
  }, [live]);
  if (!kinds.length && live.some((a) => a.loading))
    // Same markup as one real capacity row, so the card keeps its height.
    return (
      <div className="space-y-3" aria-hidden>
        <div className="space-y-1">
          <div className="relative flex items-baseline justify-between gap-2 text-[11px]">
            <span className="invisible">Weekly</span>
            <Skeleton className="absolute inset-y-[3px] left-0 w-1/3" />
          </div>
          <Skeleton className="h-2.5 rounded-[3px]" />
        </div>
      </div>
    );
  if (!live.length)
    return <p className="text-xs text-text-muted">No active accounts with readable quota.</p>;
  return (
    <div className="space-y-3">
      {kinds.map((k) => {
        const pct = k.cells.filter((c) => c.w.remaining != null);
        const sum = pct.reduce((s, c) => s + (c.w.remaining ?? 0), 0) / 100;
        const usable = pct.filter((c) => (c.w.remaining ?? 0) > EXHAUSTED).length;
        const nextReset = k.cells
          .map((c) => c.w.resetAt)
          .filter((r): r is string => !!r && new Date(r).getTime() > now)
          .sort()[0];
        return (
          <div key={k.label} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-text-muted">{k.label}</span>
              <span className="tabular-nums">
                {pct.length ? (
                  <>
                    <b className={cn("font-semibold", usable === 0 && "text-danger-text")}>
                      {usable}
                    </b>
                    <span className="text-text-muted">
                      {" "}
                      of {pct.length} usable · {sum.toFixed(1)} accounts&rsquo; worth
                    </span>
                  </>
                ) : (
                  <span className="text-text-muted">{pctText(k.cells[0].w)}</span>
                )}
                {nextReset && (
                  <span className="text-text-subtle"> · ↻ {untilText(nextReset, now)}</span>
                )}
              </span>
            </div>
            <div className="flex gap-0.5">
              {k.cells.map((c) => (
                <button
                  key={c.a.id}
                  type="button"
                  aria-label={`${c.a.label}: ${pctText(c.w)} left`}
                  onMouseEnter={() => setHover?.(c.a.id)}
                  onMouseLeave={() => setHover?.(null)}
                  onClick={() => onPick?.(c.a.id)}
                  title={`${c.a.label}: ${pctText(c.w)} left${c.w.resetAt ? ` · resets in ${untilText(c.w.resetAt, now)}` : ""}`}
                  className={cn(
                    "relative h-2.5 flex-1 overflow-hidden rounded-[3px] bg-surface-3 transition",
                    hover && hover !== c.a.id && "opacity-40",
                  )}
                >
                  <span
                    className={cn("absolute inset-y-0 left-0", barTone(c.w.remaining))}
                    style={{
                      width: c.w.remaining == null ? "100%" : `${Math.max(0, c.w.remaining)}%`,
                      opacity: c.w.remaining == null ? 0.35 : 1,
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CapacityCard({
  group,
  now,
  onOpen,
  hover,
  setHover,
}: {
  group: Group;
  now: number;
  onOpen: () => void;
  hover: string | null;
  setHover: (id: string | null) => void;
}) {
  const off = group.accounts.filter((a) => !a.isActive).length;
  const broken = group.accounts.filter((a) => a.isActive && a.error).length;
  return (
    <Panel className={cn("space-y-4 p-4", group.status === "error" && "border-danger-border")}>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-2 text-left">
        <ProviderLogo providerId={group.provider} name={providerName(group.provider)} size={22} />
        <span className="font-medium">{providerName(group.provider)}</span>
        <span className="text-xs text-text-subtle">{group.accounts.length}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {off > 0 && <Tag>{off} off</Tag>}
          {broken > 0 && <Tag tone="danger">{broken} can&rsquo;t read</Tag>}
          <Icon name="chevron_right" size={18} className="text-text-subtle" />
        </span>
      </button>
      <Capacity group={group} now={now} hover={hover} setHover={setHover} onPick={() => onOpen()} />
    </Panel>
  );
}

function ProviderDetail({
  group,
  now,
  span,
  setSpan,
  hover,
  setHover,
  onPick,
  actions,
}: {
  group: Group;
  now: number;
  span: Span;
  setSpan: (s: Span) => void;
  hover: string | null;
  setHover: (id: string | null) => void;
  onPick: (id: string) => void;
  actions: Actions;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <ProviderLogo providerId={group.provider} name={providerName(group.provider)} size={40} />
        <div>
          <h1 className="font-display text-3xl">{providerName(group.provider)}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {group.accounts.length} account{group.accounts.length === 1 ? "" : "s"} ·{" "}
            {group.accounts.filter((a) => a.isActive).length} routing
          </p>
        </div>
      </div>
      <Panel className="p-5">
        <Capacity group={group} now={now} hover={hover} setHover={setHover} onPick={onPick} />
      </Panel>
      <ResetTimeline
        accounts={group.accounts}
        now={now}
        span={span}
        setSpan={setSpan}
        highlight={hover}
        onHover={setHover}
        onPick={onPick}
        title="Coming back"
      />
      <section className="space-y-3">
        <h2 className="font-display text-xl">Accounts</h2>
        <Panel className="divide-y divide-border">
          {group.accounts.map((a) => (
            <div
              key={a.id}
              onMouseEnter={() => setHover(a.id)}
              onMouseLeave={() => setHover(null)}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 px-4 py-3",
                hover === a.id && "bg-surface-2/60",
                !a.isActive && "opacity-60",
              )}
            >
              <div className="min-w-0 space-y-2.5">
                <button
                  type="button"
                  onClick={() => onPick(a.id)}
                  className="flex items-center gap-2 text-left"
                >
                  <span className="text-[13px] font-medium hover:text-accent-text">{a.label}</span>
                  {a.plan && <Tag>{a.plan}</Tag>}
                  <AccountStatus a={a} />
                </button>
                {a.error ? (
                  <p className="text-xs text-danger-text">{a.error}</p>
                ) : (
                  <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    {a.windows.map((w) => (
                      <WindowBar key={w.name} w={w} now={now} size="sm" />
                    ))}
                  </div>
                )}
              </div>
              <AccountActions a={a} actions={actions} compact />
            </div>
          ))}
        </Panel>
      </section>
    </>
  );
}

function AccountDetail({
  a,
  siblings,
  now,
  span,
  setSpan,
  actions,
  onPick,
}: {
  a: QuotaAccount;
  siblings: QuotaAccount[];
  now: number;
  span: Span;
  setSpan: (s: Span) => void;
  actions: Actions;
  onPick: (id: string) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <ProviderLogo providerId={a.provider} name={providerName(a.provider)} size={40} />
          <div>
            <h1 className="break-all font-display text-3xl">{a.label}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-text-muted">
              {providerName(a.provider)}
              {a.plan && <span>· {a.plan}</span>}
              <span>·</span>
              <AccountStatus a={a} />
            </div>
          </div>
        </div>
        <AccountActions a={a} actions={actions} />
      </div>
      {a.error ? (
        <EmptyState icon="error">{a.error}</EmptyState>
      ) : (
        <Panel className="grid gap-x-8 gap-y-6 p-6 sm:grid-cols-2">
          {a.windows.map((w) => (
            <WindowBar
              key={w.name}
              w={w}
              now={now}
              onHide={w.key ? () => void actions.setHidden(a.provider, w.key, true) : undefined}
            />
          ))}
          {!a.windows.length &&
            (a.loading ? (
              [0, 1].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-1.5 rounded-full" />
                  <Skeleton className="h-3.5 w-1/2" />
                </div>
              ))
            ) : (
              <p className="text-sm text-text-muted">No limits reported.</p>
            ))}
        </Panel>
      )}
      {a.hidden.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          Hidden for all {providerName(a.provider)} accounts:
          {a.hidden.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => void actions.setHidden(a.provider, w.key, false)}
              className="rounded-full bg-surface-2 px-2 py-0.5 hover:bg-surface-3 hover:text-text"
            >
              {windowLabel(w.name)} · show
            </button>
          ))}
        </p>
      )}
      <ResetTimeline accounts={[a]} now={now} span={span} setSpan={setSpan} title="Comes back" />
      {siblings.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-xl">Other {providerName(a.provider)} accounts</h2>
          <Panel className="divide-y divide-border">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onPick(s.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-surface-2/60"
              >
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="text-xs text-text-muted">{statusWord(s)}</span>
                <span
                  className={cn(
                    "w-12 text-right text-xs tabular-nums",
                    s.worst != null && s.worst < LOW && "text-danger-text",
                  )}
                >
                  {s.worst != null ? `${Math.round(s.worst)}%` : "—"}
                </span>
              </button>
            ))}
          </Panel>
        </section>
      )}
      <p className="text-xs text-text-subtle">
        {(() => {
          const p = actions.autoPingFor(a);
          return p.schedule
            ? "Auto-ping is on a schedule. "
            : p.reactive
              ? "Auto-ping starts a new window after each reset. "
              : "";
        })()}
        Limits refresh every minute{a.provider === "claude" ? " (Claude every 10 minutes)" : ""}.
      </p>
    </>
  );
}

function RefreshAll({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      icon="refresh"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRefresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      Refresh all
    </Button>
  );
}

/** Bulk routing: turn off accounts that are out of quota / back on once refilled. */
function BulkMenu({ accounts, actions }: { accounts: QuotaAccount[]; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "off" | "on">(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const depleted = accounts.filter(
    (a) => a.isActive && !a.error && a.worst != null && a.worst <= EXHAUSTED,
  );
  const refilled = accounts.filter(
    (a) => !a.isActive && !a.error && a.worst != null && a.worst > EXHAUSTED,
  );
  const target = confirm === "off" ? depleted : refilled;
  return (
    <>
      <IconButton
        ref={ref}
        icon="more_horiz"
        label="Pause or resume accounts"
        onClick={() => setOpen(!open)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        side="bottom-end"
        className="w-80 py-1"
      >
        <BulkItem
          icon="pause_circle"
          title="Pause exhausted accounts"
          hint={
            depleted.length
              ? `Stop routing to accounts with ${EXHAUSTED}% or less left until you resume them.`
              : "No active account is out of quota right now."
          }
          count={depleted.length}
          onClick={() => (setOpen(false), setConfirm("off"))}
        />
        <BulkItem
          icon="play_circle"
          title="Resume refilled accounts"
          hint={
            refilled.length
              ? "Route to turned-off accounts again now that they have quota left."
              : "No turned-off account has quota left right now."
          }
          count={refilled.length}
          onClick={() => (setOpen(false), setConfirm("on"))}
        />
      </Popover>
      <ConfirmDialog
        open={confirm != null}
        onClose={() => setConfirm(null)}
        loading={busy}
        variant={confirm === "off" ? "danger" : "primary"}
        confirmIcon={confirm === "off" ? "pause" : "play_arrow"}
        title={confirm === "off" ? "Pause exhausted accounts?" : "Resume refilled accounts?"}
        message={
          confirm === "off"
            ? `${plural(target.length)} will stop receiving requests until you resume them: ${target.map((a) => a.label).join(", ")}.`
            : `${plural(target.length)} will receive requests again: ${target.map((a) => a.label).join(", ")}.`
        }
        confirmText={confirm === "off" ? "Pause accounts" : "Resume accounts"}
        onConfirm={async () => {
          setBusy(true);
          try {
            await actions.setActive(
              target.map((a) => a.id),
              confirm === "on",
            );
          } finally {
            setBusy(false);
            setConfirm(null);
          }
        }}
      />
    </>
  );
}

function CapacitySkeleton() {
  return (
    <Panel className="space-y-4 p-4" aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton className="size-[22px] rounded-md" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-2.5 rounded-[3px]" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

const plural = (n: number) => (n === 1 ? "1 account" : `${n} accounts`);

/** Disabled (with the reason as its hint) when no account applies. */
function BulkItem({
  icon,
  title,
  hint,
  count,
  onClick,
}: {
  icon: string;
  title: string;
  hint: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={count === 0}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
    >
      <Icon name={icon} size={18} className="mt-px text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{title}</span>
        <span className="block text-[11px] leading-snug text-text-muted">{hint}</span>
      </span>
      <span className="mt-0.5 rounded-full bg-surface-2 px-1.5 text-[11px] tabular-nums text-text-muted">
        {count}
      </span>
    </button>
  );
}

/** Small screens show one pane at a time; this switches between them. */
function MobileSwitch({
  value,
  onChange,
}: {
  value: "accounts" | "overview";
  onChange: (v: "accounts" | "overview") => void;
}) {
  return (
    <Segmented<"accounts" | "overview">
      value={value}
      onChange={onChange}
      options={[
        { value: "accounts", label: "Accounts" },
        { value: "overview", label: "Overview" },
      ]}
      className="w-full md:hidden"
    />
  );
}
