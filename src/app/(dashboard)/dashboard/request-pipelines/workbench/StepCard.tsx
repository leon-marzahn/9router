"use client";

import { Icon, IconButton, Input, Switch, Tag } from "@/ui";
import { cn } from "@/ui/cn";
import { KIND, describe, kindOf, type Step, type StepStat } from "./steps";

function Param({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1 text-[11px] text-text-muted", className)}>
      {label}
      {children}
    </label>
  );
}

export function StepCard({
  index,
  step: s,
  stat,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  step: Step;
  stat: StepStat | null | undefined;
  count: number;
  onChange: (s: Step) => void;
  onMove: (d: number) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(s);
  const on = s.enabled !== false;
  const set = (patch: Partial<Step>) => onChange({ ...s, ...patch });
  const canKeep = kind !== "redact";
  const canUnclosed = kind === "tag" || kind === "markers";
  return (
    <div
      className={cn(
        "space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-soft",
        !on && "opacity-60",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-medium">
          {index + 1}
        </span>
        <Icon name={KIND[kind].icon} size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{s.label || KIND[kind].label}</div>
          <div className="truncate text-[12px] text-text-muted">{describe(s)}</div>
        </div>
        {on && stat && (
          <Tag
            tone={stat.replaced ? "success" : "neutral"}
            title={`${stat.matches} matched, ${stat.preserved} kept`}
          >
            {stat.replaced} in sample
          </Tag>
        )}
        <Switch
          checked={on}
          label={`Step ${index + 1} enabled`}
          onChange={(v) => set({ enabled: v ? undefined : false })}
        />
        <span className="hidden items-center sm:flex">
          <IconButton
            icon="arrow_upward"
            label="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            icon="arrow_downward"
            label="Move down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          />
        </span>
        <IconButton icon="close" label="Remove step" disabled={count === 1} onClick={onRemove} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {kind === "tag" && (
          <Param label="Tag name" className="w-48">
            <Input
              mono
              value={s.tag ?? ""}
              placeholder="internal_states"
              onChange={(e) => set({ tag: e.target.value })}
            />
          </Param>
        )}
        {kind === "markers" && (
          <>
            <Param label="Start marker" className="w-56 flex-1">
              <Input
                mono
                value={s.start ?? ""}
                placeholder="<!-- GFX_START -->"
                onChange={(e) => set({ start: e.target.value })}
              />
            </Param>
            <Param label="End marker" className="w-56 flex-1">
              <Input
                mono
                value={s.end ?? ""}
                placeholder="<!-- GFX_END -->"
                onChange={(e) => set({ end: e.target.value })}
              />
            </Param>
          </>
        )}
        {kind === "details" && (
          <Param label="Summary title contains" className="w-64">
            <Input
              value={s.title ?? ""}
              placeholder="Scene Plan"
              onChange={(e) => set({ title: e.target.value })}
            />
          </Param>
        )}
        {kind === "regex" && (
          <>
            <Param label="Find (regex or /regex/flags)" className="w-full">
              <textarea
                rows={2}
                spellCheck={false}
                value={s.regex}
                onChange={(e) => set({ regex: e.target.value })}
                className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent dark:border-border"
              />
            </Param>
            <Param label="Replace with" className="min-w-48 flex-1">
              <Input
                mono
                value={s.replacement}
                placeholder="nothing (remove)"
                onChange={(e) => set({ replacement: e.target.value })}
              />
            </Param>
          </>
        )}
        {kind === "redact" && (
          <p className="text-[12px] text-text-muted">
            Fixed patterns: sk-… and sk-ant-… keys, AWS access keys, GitHub tokens and JWTs become
            [redacted]. Put this step last so it also sees text other steps rewrote.
          </p>
        )}
        {canKeep && (
          <Param label="Keep the latest" className="w-28">
            <Input
              type="number"
              min={0}
              value={s.depth}
              onChange={(e) => set({ depth: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
          </Param>
        )}
        {canUnclosed && (
          <label className="flex h-9 items-center gap-2 text-[12px] text-text-muted">
            <input
              type="checkbox"
              checked={!!s.unclosed}
              onChange={(e) => set({ unclosed: e.target.checked || undefined })}
            />
            Also remove when the end is missing
          </label>
        )}
      </div>
    </div>
  );
}
