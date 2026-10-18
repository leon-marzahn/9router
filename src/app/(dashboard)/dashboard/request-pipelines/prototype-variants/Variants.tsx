// PROTOTYPE: three Request Pipelines layouts over the same mock data. Previews run the real engine in the browser.
"use client";

import { useMemo, useState } from "react";
import { Button, Eyebrow, Icon, IconButton, ListGroup, ListRow, Panel, Segmented, Switch, Tag } from "@/ui";
import { cn } from "@/ui/cn";
import { KIND, PIPELINES, RECIPES, SAMPLE, describe, fmt, run, toRule, type Attach, type Change, type Pipeline, type Step } from "./mock";

const ATTACH_ICON = { header: "http", key: "key", combo: "layers" } as const;
const ATTACH_LABEL = { header: "Header", key: "API key", combo: "Combo" } as const;

function AttachChip({ a }: { a: Attach }) {
  return (
    <Tag tone={a.type === "header" ? "neutral" : "accent"} mono={a.type === "header"}>
      <Icon name={ATTACH_ICON[a.type]} size={13} />
      {a.type === "header" ? `X-Regent-Pipeline: ${a.value}` : a.value}
    </Tag>
  );
}

function ChangeList({ changes, compact }: { changes: Change[]; compact?: boolean }) {
  if (!changes.length) return <p className="text-[13px] text-text-muted">Nothing in this request matches.</p>;
  return (
    <div className="space-y-3">
      {changes.map((c) => (
        <div key={c.path} className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted">{c.path}</div>
          <div className={cn("grid font-mono text-[12px] leading-relaxed", compact ? "" : "md:grid-cols-2")}>
            <div className="whitespace-pre-wrap break-words bg-danger/5 px-3 py-2 text-text-muted line-through decoration-danger/40">{c.before}</div>
            <div className="whitespace-pre-wrap break-words bg-success/5 px-3 py-2">{c.after || <span className="text-text-subtle">(empty)</span>}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepEditor({ s, onChange }: { s: Step; onChange: (s: Step) => void }) {
  const field = "h-8 rounded-lg border border-border bg-surface-2 px-2 font-mono text-[12px]";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
      {s.kind === "strip-tag" && (
        <>
          tag <input className={cn(field, "w-40")} value={s.tag} onChange={(e) => onChange({ ...s, tag: e.target.value })} />
        </>
      )}
      {(s.kind === "replace") && (
        <>
          find <input className={cn(field, "w-48")} value={s.regex} onChange={(e) => onChange({ ...s, regex: e.target.value })} />
          with <input className={cn(field, "w-48")} value={s.replacement} onChange={(e) => onChange({ ...s, replacement: e.target.value })} />
        </>
      )}
      {s.kind !== "redact" && (
        <>
          keep latest <input type="number" min={0} className={cn(field, "w-14")} value={s.keep ?? 0} onChange={(e) => onChange({ ...s, keep: Number(e.target.value) })} />
        </>
      )}
      {s.kind === "redact" && <span>Built-in patterns: OpenAI/Anthropic keys, AWS access keys, GitHub tokens, JWTs.</span>}
    </div>
  );
}

function usePipelines() {
  const [list, setList] = useState(PIPELINES);
  const update = (name: string, p: Pipeline) => setList((l) => l.map((x) => (x.name === name ? p : x)));
  return { list, update };
}

/** A · Step workbench: pipeline list left; friendly step cards, "applies to", and a live diff right. */
export function VariantWorkbench() {
  const { list, update } = usePipelines();
  const [sel, setSel] = useState(list[0].name);
  const p = list.find((x) => x.name === sel)!;
  const result = useMemo(() => run(p), [p]);
  const setStep = (s: Step) => update(p.name, { ...p, steps: p.steps.map((x) => (x.id === s.id ? s : x)) });
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="shrink-0 border-b border-border p-2 md:w-80 md:overflow-y-auto md:border-b-0 md:border-r">
        <ListGroup title="Pipelines" count={list.length}>
          {list.map((x) => (
            <ListRow
              key={x.name}
              active={x.name === sel}
              onClick={() => setSel(x.name)}
              leading={<Icon name="filter_alt" size={18} className="text-text-muted" />}
              title={<span className="font-mono">{x.name}</span>}
              subtitle={`${x.steps.length} step${x.steps.length === 1 ? "" : "s"} · ${x.requests24h ? `${fmt(x.requests24h)} req today` : `idle · ${x.lastUsed}`}`}
            />
          ))}
          <div className="px-2 pt-2">
            <Button size="sm" variant="ghost" icon="add" className="w-full justify-start">New pipeline</Button>
          </div>
        </ListGroup>
      </aside>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-mono text-2xl">{p.name}</h1>
              <p className="mt-1 text-[13px] text-text-muted">{p.description}</p>
              <p className="mt-1 text-[12px] text-text-subtle">
                {fmt(p.requests24h)} requests today{p.tokensSaved24h ? ` · ~${fmt(p.tokensSaved24h)} tokens saved` : ""} · last used {p.lastUsed}
              </p>
            </div>
            <IconButton icon="more_horiz" label="More" />
          </header>

          <section className="space-y-2">
            <Eyebrow>Applies to</Eyebrow>
            <div className="flex flex-wrap items-center gap-2">
              {p.attach.map((a) => <AttachChip key={a.type + a.value} a={a} />)}
              <Button size="sm" variant="ghost" icon="add">Attach to key or combo</Button>
            </div>
          </section>

          <section className="space-y-2">
            <Eyebrow>Steps · run top to bottom</Eyebrow>
            <ol className="space-y-2">
              {p.steps.map((s, i) => (
                <li key={s.id}>
                  <Panel className={cn("space-y-3 p-4", !s.enabled && "opacity-60")}>
                    <div className="flex items-center gap-3">
                      <span className="flex size-7 items-center justify-center rounded-full bg-surface-2 text-[12px] font-medium">{i + 1}</span>
                      <Icon name={KIND[s.kind].icon} size={18} className="text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium">{KIND[s.kind].label}</div>
                        <div className="truncate text-[12px] text-text-muted">{describe(s)}</div>
                      </div>
                      <Tag tone={result.stats[i]?.replaced ? "success" : "neutral"}>
                        {result.stats[i] ? `${result.stats[i].replaced} in sample` : "off"}
                      </Tag>
                      <Switch checked={s.enabled} label="Enabled" onChange={(v: boolean) => setStep({ ...s, enabled: v })} />
                    </div>
                    <StepEditor s={s} onChange={setStep} />
                  </Panel>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2 pt-1">
              {(Object.keys(KIND) as (keyof typeof KIND)[]).map((k) => (
                <Button key={k} size="sm" variant="secondary" icon={KIND[k].icon}>
                  {KIND[k].label}
                  {KIND[k].isNew && <Tag tone="info">new</Tag>}
                </Button>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Eyebrow>Live preview · sample request</Eyebrow>
              <span className="text-[12px] text-text-subtle">{result.saved > 0 ? `${result.saved} chars smaller` : "no size change"}</span>
            </div>
            <ChangeList changes={result.changes} />
          </section>
        </div>
      </div>
    </div>
  );
}

/** B · Playground: the request is the page. Pick a real recent request, toggle steps, watch it change. */
export function VariantPlayground() {
  const { list, update } = usePipelines();
  const [sel, setSel] = useState(list[0].name);
  const [view, setView] = useState<"diff" | "after" | "rules">("diff");
  const p = list.find((x) => x.name === sel)!;
  const result = useMemo(() => run(p), [p]);
  const setStep = (s: Step) => update(p.name, { ...p, steps: p.steps.map((x) => (x.id === s.id ? s : x)) });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <Icon name="science" size={20} className="text-accent" />
        <span className="text-[13px] font-medium">Test on</span>
        <select className="h-8 rounded-lg border border-border bg-surface-2 px-2 text-[12px]">
          <option>Recent: coding-fast · claude-code · 12s ago</option>
          <option>Recent: gpt-5 · cursor · 2m ago</option>
          <option>Paste JSON…</option>
        </select>
        <span className="text-[12px] text-text-subtle">captured from the request log, kept in memory only</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[13px] text-text-muted">Pipeline</span>
          <Segmented value={sel} onChange={setSel} size="sm" options={list.map((x) => ({ value: x.name, label: x.name }))} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="shrink-0 space-y-2 border-b border-border p-4 lg:w-96 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <Eyebrow>Steps</Eyebrow>
          {p.steps.map((s, i) => (
            <div key={s.id} className={cn("space-y-2 rounded-xl border border-border p-3", s.enabled ? "bg-surface" : "bg-surface-2 opacity-60")}>
              <div className="flex items-center gap-2">
                <Icon name={KIND[s.kind].icon} size={16} className="text-accent" />
                <span className="flex-1 text-[13px] font-medium">{KIND[s.kind].label}</span>
                <span className="font-mono text-[11px] text-text-muted">{result.stats[i]?.matches ?? 0} hits</span>
                <Switch checked={s.enabled} label="Enabled" onChange={(v: boolean) => setStep({ ...s, enabled: v })} />
              </div>
              <StepEditor s={s} onChange={setStep} />
            </div>
          ))}
          <Button size="sm" variant="ghost" icon="add" className="w-full justify-start">Add step</Button>
          <div className="space-y-1 pt-4 text-[12px] text-text-muted">
            <div className="flex justify-between"><span>Size change</span><span className="font-mono text-text">−{result.saved} chars</span></div>
            <div className="flex justify-between"><span>Fields changed</span><span className="font-mono text-text">{result.changes.length}</span></div>
            <div className="flex justify-between"><span>Ran in</span><span className="font-mono text-text">0.4 ms · sandboxed</span></div>
          </div>
          <Button variant="primary" size="sm" className="mt-2 w-full">Save {p.name}</Button>
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mb-4 flex items-center gap-3">
            <Segmented
              value={view}
              onChange={setView}
              size="sm"
              options={[
                { value: "diff", label: `Changes · ${result.changes.length}` },
                { value: "after", label: "Request sent" },
                { value: "rules", label: "Compiled rules" },
              ]}
            />
          </div>
          {view === "diff" && <ChangeList changes={result.changes} />}
          {view === "after" && (
            <pre className="overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-4 font-mono text-[12px]">{JSON.stringify(result.body, null, 2)}</pre>
          )}
          {view === "rules" && (
            <pre className="overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-2 p-4 font-mono text-[12px]">{JSON.stringify(p.steps.filter((s) => s.enabled).map(toRule), null, 2)}</pre>
          )}
        </main>
      </div>
    </div>
  );
}

/** C · Recipes + attach: a routing-table overview (what runs for whom) and templates to start from; rules read as sentences. */
export function VariantRecipes() {
  const { list } = usePipelines();
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.flatMap((p) => p.attach.map((a) => ({ a, p })));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-6 md:px-8 md:py-8">
        <header>
          <h1 className="text-2xl">Request Pipelines</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-text-muted">
            Clean up requests before they reach a provider: strip stale agent state, mask secrets, rewrite prompts. Attach a pipeline to an API key or a combo, or let a client choose with a header.
          </p>
        </header>

        <section className="space-y-3">
          <Eyebrow>Start from a recipe</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {RECIPES.map((r) => (
              <Panel key={r.title} interactive className="space-y-2 p-4">
                <Icon name={r.icon} size={22} className="text-accent" />
                <div className="text-[14px] font-medium">{r.title}</div>
                <p className="text-[12px] text-text-muted">{r.blurb}</p>
                <div className="flex flex-wrap gap-1">
                  {r.steps.map((k) => <Tag key={k}>{KIND[k].label}</Tag>)}
                </div>
              </Panel>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <Eyebrow>What runs, for whom</Eyebrow>
          <Panel className="divide-y divide-border">
            <div className="hidden grid-cols-[1.2fr_auto_1fr_1fr] gap-4 px-4 py-2 text-[11px] uppercase tracking-wider text-text-subtle md:grid">
              <span>When the request comes from</span><span /><span>Run</span><span>Today</span>
            </div>
            {rows.map(({ a, p }) => (
              <div key={p.name + a.value} className="grid grid-cols-1 items-center gap-2 px-4 py-3 md:grid-cols-[1.2fr_auto_1fr_1fr] md:gap-4">
                <span className="flex items-center gap-2 text-[13px]">
                  <Icon name={ATTACH_ICON[a.type]} size={16} className="text-text-muted" />
                  <span className="text-text-muted">{ATTACH_LABEL[a.type]}</span>
                  <span className={cn(a.type === "header" && "font-mono")}>{a.value}</span>
                </span>
                <Icon name="arrow_forward" size={16} className="hidden text-text-subtle md:block" />
                <button type="button" onClick={() => setOpen(open === p.name ? null : p.name)} className="text-left font-mono text-[13px] text-accent-text hover:underline">{p.name}</button>
                <span className="text-[12px] text-text-muted">{p.requests24h ? `${fmt(p.requests24h)} req${p.tokensSaved24h ? ` · −${fmt(p.tokensSaved24h)} tok` : ""}` : "unused"}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-text-muted">
              <Icon name="block" size={16} /> Everything else → unchanged
              <Button size="sm" variant="ghost" icon="add" className="ml-auto">Add rule</Button>
            </div>
          </Panel>
        </section>

        <section className="space-y-3">
          <Eyebrow>Pipelines</Eyebrow>
          {list.map((p) => {
            const r = open === p.name ? run(p) : null;
            return (
              <Panel key={p.name} className="p-4">
                <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(open === p.name ? null : p.name)}>
                  <Icon name="filter_alt" size={18} className="mt-0.5 text-text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[14px]">{p.name}</div>
                    <ol className="mt-1 space-y-0.5 text-[13px] text-text-muted">
                      {p.steps.map((s, i) => <li key={s.id}>{i + 1}. {describe(s)}</li>)}
                    </ol>
                  </div>
                  <Icon name={open === p.name ? "expand_less" : "expand_more"} size={20} className="text-text-subtle" />
                </button>
                {r && <div className="mt-4 border-t border-border pt-4"><Eyebrow className="mb-2">On a sample request</Eyebrow><ChangeList changes={r.changes} compact /></div>}
              </Panel>
            );
          })}
        </section>
      </div>
    </div>
  );
}
