"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "./Button";
import { cn } from "./cn";
import { Dialog } from "./Dialog";
import { SearchInput } from "./Field";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import {
  buildPickerSections,
  moveActive,
  optionKeys,
  type PickerGroup,
  type PickerModel,
} from "./modelPickerLogic";

/**
 * Single-model picker: a trigger showing the current model that opens a
 * searchable list grouped by provider (a centered dialog on md+, a bottom
 * sheet below). Type to filter by id or name; ↑/↓, Home/End and Enter work
 * from the search field. `recent` ids are listed first while not searching.
 */
export function ModelPicker({
  groups,
  value,
  onChange,
  recent = [],
  disabled,
  placeholder = "Select model",
  title = "Choose a model",
  className,
}: {
  groups: PickerGroup[];
  value: string | null;
  onChange: (id: string) => void;
  recent?: string[];
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => {
    for (const g of groups) {
      const m = g.models.find((x) => x.id === value);
      if (m) return m;
    }
    return null;
  }, [groups, value]);

  return (
    <>
      <Button
        data-model-picker
        aria-haspopup="dialog"
        aria-label={current ? `Model: ${current.name}` : placeholder}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn("min-w-0 justify-between gap-1 font-normal", className)}
      >
        <span className="min-w-0 truncate">{current?.name ?? placeholder}</span>
        <Icon name="unfold_more" size={16} className="shrink-0 text-text-subtle" />
      </Button>
      {open && (
        <PickerDialog
          groups={groups}
          value={value}
          recent={recent}
          title={title}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false);
            onChange(id);
          }}
        />
      )}
    </>
  );
}

function PickerDialog({
  groups,
  value,
  recent,
  title,
  onClose,
  onPick,
}: {
  groups: PickerGroup[];
  value: string | null;
  recent: string[];
  title: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => buildPickerSections(groups, query, recent),
    [groups, query, recent],
  );
  const keys = useMemo(() => optionKeys(sections), [sections]);
  // The highlighted option's key; null (or a key no longer listed) falls back to
  // the first match while searching, else the current model.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const picked = activeKey ? keys.indexOf(activeKey) : -1;
  const fallback = query.trim()
    ? keys.length
      ? 0
      : -1
    : keys.findIndex((k) => k.endsWith(`::${value}`));
  const active = picked >= 0 ? picked : fallback;
  const setActive = (i: number) => setActiveKey(keys[i] ?? null);
  const baseId = useId();
  const optId = (i: number) => `${baseId}-opt-${i}`;
  // Index of each section's first option (options are numbered across sections).
  const starts = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const s of sections) {
      out.push(n);
      n += s.models.length;
    }
    return out;
  }, [sections]);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, baseId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = moveActive(e.key, active, keys.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      onPick(keys[active].slice(keys[active].indexOf("::") + 2));
    }
  };

  return (
    <Dialog open onClose={onClose} title={title} size="lg" className="md:h-[min(640px,80dvh)]">
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 bg-surface px-5 pb-2 pt-4">
        <SearchInput
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={active >= 0 ? optId(active) : undefined}
          aria-label="Search models"
          placeholder="Search models"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0"
        />
      </div>
      <div id={`${baseId}-list`} role="listbox" aria-label="Models" className="-mx-2">
        {sections.length === 0 && (
          <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
            {query.trim() ? "No models match." : "No models available."}
          </p>
        )}
        {sections.map((s, si) => (
          <div key={s.key} role="group" aria-labelledby={`${baseId}-${s.key}`} className="pb-2">
            <div
              id={`${baseId}-${s.key}`}
              className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
            >
              {s.providerId ? (
                <ProviderLogo providerId={s.providerId} name={s.title} size={16} />
              ) : (
                <Icon name="history" size={16} />
              )}
              <span className="min-w-0 truncate">{s.title}</span>
              <span className="tabular-nums">{s.models.length}</span>
            </div>
            {s.models.map((m, mi) => {
              const i = starts[si] + mi;
              return (
                <Option
                  key={m.id}
                  id={optId(i)}
                  model={m}
                  providerName={s.providerId ? undefined : m.providerName}
                  active={i === active}
                  selected={m.id === value}
                  onHover={() => setActive(i)}
                  onPick={() => onPick(m.id)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function Option({
  id,
  model,
  providerName,
  active,
  selected,
  onHover,
  onPick,
}: {
  id: string;
  model: PickerModel;
  providerName?: string;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const detail = [providerName, model.detail && model.detail !== model.name ? model.detail : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        "flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 max-md:min-h-11",
        active ? "bg-surface-2" : "",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-text">{model.name}</div>
        {detail && <div className="truncate font-mono text-[11px] text-text-subtle">{detail}</div>}
      </div>
      {selected && <Icon name="check" size={16} className="shrink-0 text-accent-text" />}
    </div>
  );
}
