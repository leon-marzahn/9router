"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Field, Icon, Input, SearchInput, Segmented, Skeleton } from "@/ui";
import { cn } from "@/ui/cn";
import { Modal } from "@/shared/components";
import { ComboDetail } from "./ComboDetail";
import { STEP_DOT } from "./steps";
import { useCombos, type Combo, type CombosApi, type Strategy } from "./useCombos";
import { VisionAdapter } from "./VisionAdapter";

const STRATEGY_LABEL: Record<Strategy, string> = {
  fallback: "In order",
  "round-robin": "Take turns",
  "per-chat": "Per chat",
  fusion: "Ask all",
};
const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;
const VISION = "__vision";
type Scope = "all" | "attention";

const down = (api: CombosApi, m: string) => ["cooling", "off"].includes(api.readiness[m]?.state ?? "");

export function CombosWorkbench() {
  const api = useCombos();
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("combo");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [naming, setNaming] = useState<null | { mode: "new" } | { mode: "rename"; combo: Combo }>(null);

  const select = (id: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (id) p.set("combo", id);
    else p.delete("combo");
    router.replace(`/dashboard/combos${p.size ? `?${p}` : ""}`, { scroll: false });
  };

  const all = api.combos ?? [];
  const attention = all.filter((c) => c.models.length === 0 || c.models.some((m) => down(api, m)));
  const shown = (scope === "attention" ? attention : all).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const current = all.find((c) => c.name === sel);
  const showDetail = !!current || sel === VISION;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn("flex min-h-0 w-full flex-1 flex-col border-r border-border bg-pane md:w-[340px] md:flex-none", showDetail && "hidden md:flex")}>
        <div className="space-y-2 p-3">
          <div className="flex gap-2">
            <SearchInput placeholder="Search combos" value={q} onChange={(e) => setQ(e.target.value)} shortcut="/" className="min-w-0 flex-1" />
            <Button variant="primary" size="sm" icon="add" onClick={() => setNaming({ mode: "new" })}>
              New
            </Button>
          </div>
          <Segmented<Scope>
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: api.combos ? `All · ${all.length}` : "All" },
              { value: "attention", label: `Needs attention${attention.length ? ` · ${attention.length}` : ""}` },
            ]}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1">
          {!api.combos
            ? [0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5 rounded-lg px-2.5 py-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))
            : shown.map((c) => {
                const active = c.name === sel;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => select(active ? null : c.name)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Icon name="layers" size={16} className={active ? "text-accent" : "text-text-muted"} />
                      <span className={cn("min-w-0 truncate font-mono text-[13px]", active && "font-medium text-accent-text")}>{c.name}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {c.models.slice(0, 6).map((m, i) => (
                          <span key={i} className={cn("size-1.5 rounded-full", STEP_DOT[api.readiness[m]?.state ?? (m.includes("/") ? "unknown" : "combo")])} />
                        ))}
                      </span>
                    </span>
                    <span className="pl-6 text-[11px] text-text-subtle">
                      {STRATEGY_LABEL[api.strategyOf(c.name)]} · {c.models.length} step{c.models.length === 1 ? "" : "s"}
                    </span>
                  </button>
                );
              })}
          {api.combos && !shown.length && (
            <p className="px-3 py-6 text-sm text-text-muted">{all.length ? "No combos match." : "No combos yet. A combo is a list of models tried in order, or in turns, under one name."}</p>
          )}
        </div>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => select(sel === VISION ? null : VISION)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
              sel === VISION ? "bg-accent-soft font-medium text-accent-text ring-1 ring-accent-ring" : "text-text-muted hover:bg-surface-2",
            )}
          >
            <Icon name="visibility" size={16} />
            Vision fallback
          </button>
        </div>
      </aside>

      <section className={cn("min-h-0 flex-1 overflow-y-auto", !showDetail && "hidden md:block")}>
        {sel === VISION ? (
          <VisionAdapter onBack={() => select(null)} />
        ) : current ? (
          <ComboDetail key={current.id} combo={current} api={api} onBack={() => select(null)} onRename={() => setNaming({ mode: "rename", combo: current })} />
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-[13px] text-text-muted">
            <div className="flex flex-col items-center gap-2">
              <Icon name="layers" size={28} className="text-text-subtle" />
              Pick a combo to see its steps and how it routes.
            </div>
          </div>
        )}
      </section>

      {naming && (
        <NameDialog
          initial={naming.mode === "rename" ? naming.combo.name : ""}
          title={naming.mode === "rename" ? "Rename combo" : "New combo"}
          taken={(n) => all.some((c) => c.name === n && (naming.mode === "new" || c.id !== naming.combo.id))}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            if (naming.mode === "rename") {
              await api.update(naming.combo.id, { name });
              select(name);
            } else select((await api.create(name, [])).name);
            setNaming(null);
          }}
        />
      )}
    </div>
  );
}

function NameDialog({ initial, title, taken, onClose, onSave }: { initial: string; title: string; taken: (n: string) => boolean; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = name.trim();
  const problem = !n ? null : !VALID_NAME.test(n) ? "Letters, numbers, - _ and . only" : taken(n) ? "Another combo has that name" : null;
  const submit = async () => {
    if (!n || problem) return;
    setBusy(true);
    try {
      await onSave(n);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={initial ? "check" : "add"} loading={busy} disabled={!n || !!problem || n === initial} onClick={() => void submit()}>
            {initial ? "Rename" : "Create"}
          </Button>
        </>
      }
    >
      <Field label="Name" hint="This is what apps send as the model." error={problem || error}>
        <Input
          autoFocus
          mono
          value={name}
          placeholder="claude-best"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>
    </Modal>
  );
}
