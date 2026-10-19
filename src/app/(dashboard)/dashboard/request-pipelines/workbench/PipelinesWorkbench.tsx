"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  Button,
  Icon,
  ListAddRow,
  ListGroup,
  ListRow,
  ListSkeleton,
  SearchInput,
  TopBarActions,
  WorkbenchDetail,
  WorkbenchList,
  WorkbenchOverviewRow,
  useListKeyboard,
} from "@/ui";
import { Overview } from "./Overview";
import { PipelineDetail } from "./PipelineDetail";
import { compact, timeAgo, type Pipeline } from "./steps";
import { usePipelines } from "./usePipelines";

const PATH = "/dashboard/request-pipelines";

export function uniqueName(base: string, list: Pipeline[]) {
  let name = base;
  for (let i = 2; list.some((p) => p.name === name); i++) name = `${base}-${i}`;
  return name;
}

export function PipelinesWorkbench() {
  const api = usePipelines();
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("pipeline");
  const list = api.pipelines ?? [];
  const current = list.find((p) => p.name === sel);
  // Mobile only: the overview as its own screen (desktop shows it with nothing selected)
  const overview = !current && params.get("view") === "overview";
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list;

  const select = (name: string | null) =>
    router.replace(name ? `${PATH}?pipeline=${encodeURIComponent(name)}` : PATH, { scroll: false });
  const openOverview = () => router.replace(`${PATH}?view=overview`, { scroll: false });

  const create = (template: Pipeline) => {
    const name = uniqueName(template.name, list);
    api.change([...list, { ...structuredClone(template), name }]);
    select(name);
  };
  const atLimit = list.length >= 50;
  const createBlank = () =>
    create({ name: "pipeline", rules: [{ regex: "", replacement: "", depth: 0 }] });

  useListKeyboard({
    order: shown.map((p) => p.name),
    selected: current?.name ?? null,
    onSelect: select,
    searchRef,
  });

  return (
    <div className="flex min-h-0 flex-1">
      {api.dirty && (
        <TopBarActions>
          <span className="hidden text-[12px] text-text-muted sm:inline">Unsaved changes</span>
          <Button size="sm" variant="ghost" onClick={api.discard} disabled={api.saving}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon="check"
            loading={api.saving}
            disabled={api.incomplete}
            title={api.incomplete ? "Fill in every “Keep the latest” field to save" : undefined}
            onClick={() => void api.save()}
          >
            Save
          </Button>
        </TopBarActions>
      )}
      <WorkbenchList
        selected={current?.name ?? null}
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
              placeholder="Search pipelines"
              shortcut="/"
              className="min-w-0 flex-1"
            />
            <Button size="sm" icon="add" disabled={atLimit} onClick={createBlank}>
              New
            </Button>
          </div>
        }
      >
        {!api.pipelines ? (
          <ListSkeleton rows={3} />
        ) : (
          <>
            <WorkbenchOverviewRow
              icon="alt_route"
              subtitle="What pipelines do, where they run, templates"
              onClick={openOverview}
            />
            <ListGroup title="Pipelines" count={shown.length}>
              {shown.map((p) => {
                const u = api.usage[p.name];
                const active = p.name === sel;
                return (
                  <ListRow
                    key={p.name}
                    id={p.name}
                    active={active}
                    onClick={() => select(p.name)}
                    leading={
                      <Icon
                        name="filter_alt"
                        size={16}
                        className={active ? "text-accent" : "text-text-muted"}
                      />
                    }
                    title={<span className="font-mono">{p.name}</span>}
                    subtitle={`${p.rules.length} step${p.rules.length === 1 ? "" : "s"}${
                      u ? ` · ${compact(u.requests)} req · ${timeAgo(u.lastUsed)}` : ""
                    }`}
                    version={u?.requests}
                  />
                );
              })}
            </ListGroup>
            <ListAddRow disabled={atLimit} onClick={createBlank}>
              Add pipeline
            </ListAddRow>
          </>
        )}
      </WorkbenchList>
      <WorkbenchDetail
        detailOpen={!!current || overview}
        backLabel="All pipelines"
        onBack={() => select(null)}
      >
        {current ? (
          <PipelineDetail
            key={current.name}
            pipeline={current}
            api={api}
            onRename={(name) => {
              api.update(current.name, { ...current, name });
              select(name);
            }}
            onDuplicate={() =>
              create({ ...current, name: `${current.name}-copy`, attach: undefined })
            }
            onDelete={() => {
              api.change(list.filter((p) => p !== current));
              select(null);
            }}
          />
        ) : (
          <Overview api={api} onOpen={select} onCreate={create} />
        )}
      </WorkbenchDetail>
    </div>
  );
}
