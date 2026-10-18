"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button, Icon, Skeleton, TopBarActions } from "@/ui";
import { cn } from "@/ui/cn";
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

  const select = (name: string | null) =>
    router.replace(name ? `${PATH}?pipeline=${encodeURIComponent(name)}` : PATH, { scroll: false });

  const create = (template: Pipeline) => {
    const name = uniqueName(template.name, list);
    api.change([...list, { ...structuredClone(template), name }]);
    select(name);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
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
            onClick={() => void api.save()}
          >
            Save
          </Button>
        </TopBarActions>
      )}
      <aside
        className={cn(
          "flex w-full flex-none flex-col border-b border-border bg-pane md:min-h-0 md:w-[300px] md:border-b-0 md:border-r",
          current && "hidden md:flex",
        )}
      >
        <div className="space-y-1 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
          <button
            type="button"
            onClick={() => select(null)}
            className={cn(
              "hidden w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors md:flex",
              !sel
                ? "bg-accent-soft font-medium text-accent-text ring-1 ring-accent-ring"
                : "text-text-muted hover:bg-surface-2",
            )}
          >
            <Icon name="alt_route" size={16} />
            Overview
          </button>
          <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-text-muted">
            Pipelines {api.pipelines && <span className="text-text-subtle">{list.length}</span>}
          </div>
          {!api.pipelines
            ? [0, 1].map((i) => (
                <div key={i} className="space-y-1.5 px-2.5 py-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              ))
            : list.map((p) => {
                const active = p.name === sel;
                const u = api.usage[p.name];
                return (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => select(p.name)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        name="filter_alt"
                        size={16}
                        className={active ? "text-accent" : "text-text-muted"}
                      />
                      <span
                        className={cn(
                          "min-w-0 truncate font-mono text-[13px]",
                          active && "font-medium text-accent-text",
                        )}
                      >
                        {p.name}
                      </span>
                    </span>
                    <span className="pl-6 text-[11px] text-text-subtle">
                      {p.rules.length} step{p.rules.length === 1 ? "" : "s"}
                      {u ? ` · ${compact(u.requests)} req · ${timeAgo(u.lastUsed)}` : ""}
                    </span>
                  </button>
                );
              })}
          {api.pipelines && (
            <Button
              size="sm"
              variant="ghost"
              icon="add"
              className="w-full justify-start"
              disabled={list.length >= 50}
              onClick={() =>
                create({ name: "pipeline", rules: [{ regex: "", replacement: "", depth: 0 }] })
              }
            >
              New pipeline
            </Button>
          )}
        </div>
      </aside>
      <section className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        {current ? (
          <PipelineDetail
            key={current.name}
            pipeline={current}
            api={api}
            onBack={() => select(null)}
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
      </section>
    </div>
  );
}
