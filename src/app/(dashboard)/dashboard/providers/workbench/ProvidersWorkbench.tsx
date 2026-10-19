"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Icon,
  InlineStat,
  ListAddRow,
  ListGroup,
  ListRow,
  ProviderLogo,
  SearchInput,
  Segmented,
  StatusDot,
  Tag,
  TopBarActions,
  TopBarContent,
  needsAttention,
  cn,
  ListSkeleton,
  WorkbenchDetail,
  WorkbenchList,
  WorkbenchOverviewRow,
  useListKeyboard,
} from "@/ui";
import { KIND_LABEL, cooldownsOf, versionOf, type ProviderEntry } from "../model";
import { useProviders } from "../useProviders";
import { ProviderOverview } from "./ProviderOverview";
import { ProviderDetail } from "./ProviderDetail";
import { CustomEndpointForm, TEMPLATES } from "./CustomEndpointForm";
import { isLive, totalsOf } from "./totals";

type Scope = "live" | "all";

export function ProvidersWorkbench() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const sel = params.get("p");
  const {
    providers,
    loading,
    dataVersion,
    live: streamUp,
    testing,
    refresh,
    setConnectionActive,
    runTest,
    clearCooldown,
  } = useProviders();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("live");
  const searchRef = useRef<HTMLInputElement>(null);

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      next.delete("view");
      if (id) next.set("p", id);
      else next.delete("p");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // Mobile only: the overview as its own screen (desktop shows it with nothing selected)
  const overview = !sel && params.get("view") === "overview";
  const openOverview = () => {
    const next = new URLSearchParams(params.toString());
    next.set("view", "overview");
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  const totals = useMemo(() => totalsOf(providers), [providers]);
  const attention = providers.filter((p) => needsAttention(p.status));
  const needle = q.trim().toLowerCase();
  const matches = (p: { name: string; id: string }) =>
    !needle || p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle);
  const searching = !!needle;

  const visible = providers.filter(
    (p) => matches(p) && (scope === "all" || searching || isLive(p)),
  );
  const templates = TEMPLATES.filter(
    (t) => !needle || `${t.name} custom compatible endpoint`.toLowerCase().includes(needle),
  );
  const groups: { title: string; tone?: "danger"; items: ProviderEntry[] | typeof TEMPLATES }[] = [
    {
      title: "Needs attention",
      tone: "danger" as const,
      items: visible.filter((p) => needsAttention(p.status)),
    },
    {
      title: scope === "live" ? "Live" : "Connected",
      items: visible.filter((p) => !needsAttention(p.status) && p.status !== "none"),
    },
    { title: "Add custom endpoint", items: scope === "all" || searching ? templates : [] },
    { title: "Available", items: visible.filter((p) => p.status === "none") },
  ].filter((g) => g.items.length > 0);
  const order = groups.flatMap((g) => g.items.map((i) => i.id));

  const current = providers.find((p) => p.id === sel) ?? null;
  const template = TEMPLATES.find((t) => t.id === sel) ?? null;

  useListKeyboard({
    order,
    selected: sel,
    onSelect: select,
    searchRef,
    onEnter: (id) =>
      current?.id === id && router.push(`/dashboard/providers/${encodeURIComponent(id)}`),
  });

  return (
    <>
      <TopBarContent>
        <InlineStat value={totals.live} label="live" />
        <InlineStat value={totals.healthy} label={`of ${totals.accounts} accounts healthy`} />
        <InlineStat
          value={totals.failing}
          label="failing"
          tone="danger"
          onClick={() => attention[0] && select(attention[0].id)}
        />
        <InlineStat value={totals.free} label="free, no-auth" />
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 text-[11px]",
            streamUp ? "text-text-muted" : "text-text-subtle",
          )}
          title={
            streamUp
              ? "Updates stream in as they happen"
              : "Live updates disconnected — reconnecting"
          }
        >
          <StatusDot status={streamUp ? "ok" : "pending"} live={streamUp} />{" "}
          {streamUp ? "Live" : "Reconnecting"}
        </span>
      </TopBarContent>
      <TopBarActions>
        <Button
          icon="monitor_heart"
          loading={testing === "all"}
          disabled={!!testing && testing !== "all"}
          onClick={() => runTest("all")}
        >
          Health check
        </Button>
      </TopBarActions>

      <div className="flex min-h-0 flex-1">
        <WorkbenchList
          selected={sel}
          detailOpen={!!sel || overview}
          hints={[
            ["↑↓", "move"],
            ["↵", "open"],
            ["/", "search"],
            ["esc", "overview"],
          ]}
          header={
            <>
              <SearchInput
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search providers"
                shortcut="/"
              />
              <Segmented<Scope>
                value={scope}
                onChange={setScope}
                options={[
                  { value: "live", label: `In use · ${totals.live}` },
                  { value: "all", label: `All · ${providers.length}` },
                ]}
              />
            </>
          }
        >
          {loading ? (
            <ListSkeleton />
          ) : (
            <>
              <WorkbenchOverviewRow
                icon="dns"
                subtitle="Health, providers needing attention, what's live"
                onClick={openOverview}
              />
              {groups.map((g) => (
                <ListGroup key={g.title} title={g.title} count={g.items.length} tone={g.tone}>
                  {g.title === "Add custom endpoint"
                    ? TEMPLATES.filter((t) => g.items.some((i) => i.id === t.id)).map((t) => (
                        <ListRow
                          key={t.id}
                          id={t.id}
                          active={sel === t.id}
                          onClick={() => select(t.id)}
                          leading={<ProviderLogo src={t.icon} name={t.name} size={22} />}
                          title={t.name}
                          subtitle={t.hint}
                          trailing={<Icon name="add" size={18} className="text-text-subtle" />}
                        />
                      ))
                    : (g.items as ProviderEntry[]).map((p) => (
                        <ProviderRow
                          key={p.id}
                          p={p}
                          active={sel === p.id}
                          onClick={() => select(p.id)}
                        />
                      ))}
                </ListGroup>
              ))}
              {order.length === 0 && (
                <div className="py-10 text-center text-text-muted">Nothing matches “{q}”.</div>
              )}
              {scope === "live" && !searching && (
                <div className="mt-2 space-y-2 px-2">
                  <ListAddRow onClick={() => setScope("all")}>Connect another provider</ListAddRow>
                  <div className="grid grid-cols-2 gap-2">
                    {TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => select(t.id)}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-lg border py-2 text-[11px]",
                          sel === t.id
                            ? "border-accent-ring bg-accent-soft text-accent-text"
                            : "border-border text-text-muted hover:text-text",
                        )}
                      >
                        <ProviderLogo src={t.icon} name={t.name} size={14} /> {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </WorkbenchList>

        <WorkbenchDetail
          detailOpen={!!sel || overview}
          backLabel="All providers"
          onBack={() => select(null)}
        >
          {template ? (
            <CustomEndpointForm
              key={template.id}
              flavor={template.flavor}
              onCreated={async (node) => {
                await refresh();
                select(node.id);
              }}
            />
          ) : current ? (
            <ProviderDetail
              key={current.id}
              p={current}
              testing={testing}
              onTest={runTest}
              onSetActive={setConnectionActive}
              onClearCooldown={clearCooldown}
              liveVersion={dataVersion}
            />
          ) : loading ? null : (
            <ProviderOverview
              totals={totals}
              attention={attention}
              live={providers.filter((p) => isLive(p) && !needsAttention(p.status))}
              testing={testing}
              onTest={runTest}
              onSelect={select}
            />
          )}
        </WorkbenchDetail>
      </div>
    </>
  );
}

function ProviderRow({
  p,
  active,
  onClick,
}: {
  p: ProviderEntry;
  active: boolean;
  onClick: () => void;
}) {
  const unconfigured = p.status === "none";
  const cooling = cooldownsOf(p).length;
  return (
    <ListRow
      id={p.id}
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
            className={unconfigured ? "opacity-50 grayscale" : ""}
          />
          <StatusDot
            status={p.status}
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-pane"
          />
        </span>
      }
      title={p.name}
      subtitle={
        <>
          {KIND_LABEL[p.kind]}
          {p.stats.total > 0 && ` · ${p.stats.connected}/${p.stats.total} accounts`}
        </>
      }
      trailing={
        p.stats.errorCode ? (
          <Tag tone="danger" mono>
            {p.stats.errorCode}
          </Tag>
        ) : cooling > 0 ? (
          <Tag tone="warning" className="gap-0.5">
            <Icon name="schedule" size={11} />
            {cooling}
          </Tag>
        ) : undefined
      }
    />
  );
}
