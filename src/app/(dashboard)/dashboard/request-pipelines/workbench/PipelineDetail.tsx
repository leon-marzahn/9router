"use client";

import { useRef, useState } from "react";
import {
  Button,
  Eyebrow,
  Field,
  Icon,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  Popover,
  Tag,
} from "@/ui";
import { cn } from "@/ui/cn";
import { ConfirmModal } from "@/shared/components";
import { Preview } from "./Preview";
import { StepCard } from "./StepCard";
import {
  KIND,
  KIND_ORDER,
  blankStep,
  compact,
  timeAgo,
  type Pipeline,
  type Step,
  type StepStat,
} from "./steps";
import type { PipelinesApi } from "./usePipelines";

const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function PipelineDetail({
  pipeline: p,
  api,
  onBack,
  onRename,
  onDelete,
}: {
  pipeline: Pipeline;
  api: PipelinesApi;
  onBack: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(p.name);
  const [stats, setStats] = useState<(StepStat | null)[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const u = api.usage[p.name];
  const attach = { keys: p.attach?.keys ?? [], combos: p.attach?.combos ?? [] };
  const others = (api.pipelines ?? []).filter((x) => x !== p);
  const nameProblem = !VALID_NAME.test(name)
    ? "1–64 letters, numbers, - and _"
    : others.some((x) => x.name === name)
      ? "Another pipeline has that name"
      : null;

  const set = (patch: Partial<Pipeline>) => api.update(p.name, { ...p, ...patch });
  const setRules = (rules: Step[]) => set({ rules });
  const setAttach = (next: typeof attach) =>
    set({ attach: next.keys.length || next.combos.length ? next : undefined });
  const move = (i: number, d: number) => {
    const rules = [...p.rules];
    [rules[i], rules[i + d]] = [rules[i + d], rules[i]];
    setRules(rules);
  };
  const keyName = (id: string) => api.keys.find((k) => k.id === id)?.name ?? "Deleted key";

  return (
    <div className="mx-auto max-w-3xl space-y-7 px-4 py-6 [font-variant-ligatures:none] md:px-8 md:py-8">
      <header className="space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-[12px] text-text-muted md:hidden"
        >
          <Icon name="arrow_back" size={14} /> Pipelines
        </button>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Field label="Name" error={name !== p.name ? nameProblem : null} className="max-w-sm">
              <Input
                mono
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => (name !== p.name && !nameProblem ? onRename(name) : setName(p.name))}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </Field>
            <p className="text-[12px] text-text-subtle">
              {u
                ? `${compact(u.requests)} requests · ${compact(u.charsRemoved)} characters removed · last used ${timeAgo(u.lastUsed)} (since restart)`
                : "Not used since the server started"}
            </p>
          </div>
          <IconButton icon="delete" label="Delete pipeline" onClick={() => setConfirm(true)} />
        </div>
        <Input
          value={p.description ?? ""}
          placeholder="What is this pipeline for? (optional)"
          maxLength={500}
          onChange={(e) => set({ description: e.target.value || undefined })}
        />
      </header>

      {api.error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger-text"
        >
          <Icon name="error" size={14} className="mt-px shrink-0" />
          {api.error}
        </p>
      )}

      <section className="space-y-2">
        <Eyebrow>Runs for</Eyebrow>
        <div className="flex flex-wrap items-center gap-2">
          {attach.keys.map((id) => (
            <Tag key={id} tone="accent">
              <Icon name="key" size={13} />
              {keyName(id)}
              <button
                type="button"
                aria-label={`Detach ${keyName(id)}`}
                onClick={() => setAttach({ ...attach, keys: attach.keys.filter((k) => k !== id) })}
              >
                <Icon name="close" size={12} />
              </button>
            </Tag>
          ))}
          {attach.combos.map((c) => (
            <Tag key={c} tone="accent">
              <Icon name="layers" size={13} />
              {c}
              <button
                type="button"
                aria-label={`Detach ${c}`}
                onClick={() =>
                  setAttach({ ...attach, combos: attach.combos.filter((x) => x !== c) })
                }
              >
                <Icon name="close" size={12} />
              </button>
            </Tag>
          ))}
          <Tag mono title="Clients can also pick this pipeline per request with this header">
            <Icon name="http" size={13} />
            X-Regent-Pipeline: {p.name}
          </Tag>
          <Button
            ref={attachRef}
            size="sm"
            variant="ghost"
            icon="add"
            onClick={() => setAttaching(true)}
          >
            Attach to key or combo
          </Button>
          <Popover
            open={attaching}
            onClose={() => setAttaching(false)}
            anchorRef={attachRef}
            side="bottom-start"
            className="max-h-80 w-64 overflow-y-auto py-1"
          >
            <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-text-subtle">
              API keys
            </div>
            {api.keys
              .filter((k) => !attach.keys.includes(k.id))
              .map((k) => (
                <MenuItem
                  key={k.id}
                  icon="key"
                  onClick={() => {
                    setAttach({ ...attach, keys: [...attach.keys, k.id] });
                    setAttaching(false);
                  }}
                >
                  {k.name}
                </MenuItem>
              ))}
            {!api.keys.some((k) => !attach.keys.includes(k.id)) && (
              <p className="px-3 py-1 text-[12px] text-text-subtle">No more keys</p>
            )}
            <MenuSeparator />
            <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-text-subtle">
              Combos
            </div>
            {api.combos
              .filter((c) => !attach.combos.includes(c.name))
              .map((c) => (
                <MenuItem
                  key={c.name}
                  icon="layers"
                  onClick={() => {
                    setAttach({ ...attach, combos: [...attach.combos, c.name] });
                    setAttaching(false);
                  }}
                >
                  <span className="font-mono">{c.name}</span>
                </MenuItem>
              ))}
            {!api.combos.some((c) => !attach.combos.includes(c.name)) && (
              <p className="px-3 py-1 text-[12px] text-text-subtle">No more combos</p>
            )}
          </Popover>
        </div>
      </section>

      <section className="space-y-2">
        <Eyebrow>Steps · run top to bottom on message text and tool results</Eyebrow>
        <ol className="space-y-2">
          {p.rules.map((s, i) => (
            <li key={i}>
              <StepCard
                index={i}
                step={s}
                stat={stats[i]}
                count={p.rules.length}
                onChange={(next) => setRules(p.rules.map((x, j) => (j === i ? next : x)))}
                onMove={(d) => move(i, d)}
                onRemove={() => setRules(p.rules.filter((_, j) => j !== i))}
              />
            </li>
          ))}
        </ol>
        <p className="text-[11px] text-text-subtle">
          “Keep the latest” counts matches across the whole request, oldest first: 1 leaves the
          newest one, 0 removes them all.
        </p>
        <Button
          ref={addRef}
          size="sm"
          variant="secondary"
          icon="add"
          disabled={p.rules.length >= 50}
          onClick={() => setAdding(true)}
        >
          Add step
        </Button>
        <Popover
          open={adding}
          onClose={() => setAdding(false)}
          anchorRef={addRef}
          side="bottom-start"
          className="w-80 py-1"
        >
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setRules([...p.rules, blankStep(k)]);
                setAdding(false);
              }}
              className={cn("flex w-full gap-3 px-3 py-2 text-left hover:bg-surface-2")}
            >
              <Icon name={KIND[k].icon} size={18} className="mt-0.5 text-accent" />
              <span>
                <span className="block text-[13px] font-medium">{KIND[k].label}</span>
                <span className="block text-[12px] text-text-muted">{KIND[k].blurb}</span>
              </span>
            </button>
          ))}
        </Popover>
      </section>

      <Preview pipeline={p} onStats={setStats} />

      <ConfirmModal
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onDelete();
        }}
        title="Delete pipeline"
        message={`Delete ${p.name}? Clients that send it in the header will get an error once you save.`}
        confirmText="Delete"
      />
    </div>
  );
}
