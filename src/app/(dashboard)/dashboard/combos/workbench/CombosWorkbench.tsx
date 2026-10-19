"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  ListGroup,
  ListRow,
  ListSkeleton,
  SearchInput,
  Segmented,
  StatusDot,
  WorkbenchDetail,
  WorkbenchList,
  WorkbenchOverviewRow,
  useListKeyboard,
  type Status,
} from "@/ui";
import { ComboDetail } from "./ComboDetail";
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
const PATH = "/dashboard/combos";
type Scope = "all" | "attention";

const down = (api: CombosApi, m: string) =>
  ["cooling", "off"].includes(api.readiness[m]?.state ?? "");

/** One status per combo: no steps → not set up, every step down → failing, some → degraded. */
function statusOf(api: CombosApi, c: Combo): Status {
  if (c.models.length === 0) return "none";
  const n = c.models.filter((m) => down(api, m)).length;
  return n === 0 ? "ok" : n === c.models.length ? "error" : "degraded";
}

export function CombosWorkbench() {
  const api = useCombos();
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("combo");
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [naming, setNaming] = useState<null | { mode: "new" } | { mode: "rename"; combo: Combo }>(
    null,
  );

  const select = (id: string | null) =>
    router.replace(id ? `${PATH}?combo=${encodeURIComponent(id)}` : PATH, { scroll: false });
  const openOverview = () => router.replace(`${PATH}?view=overview`, { scroll: false });

  const all = api.combos ?? [];
  const attention = all.filter((c) => c.models.length === 0 || c.models.some((m) => down(api, m)));
  const shown = (scope === "attention" ? attention : all).filter(
    (c) => !q || c.name.toLowerCase().includes(q.toLowerCase()),
  );
  const current = all.find((c) => c.name === sel);
  const vision = sel === VISION;
  // Mobile only: the overview as its own screen (desktop shows it with nothing selected)
  const overview = !current && !vision && params.get("view") === "overview";
  const selId = current ? current.name : vision ? VISION : null;
  const order = [...shown.map((c) => c.name), VISION];
  const failing = all.filter((c) => statusOf(api, c) === "error").length;

  useListKeyboard({ order, selected: selId, onSelect: select, searchRef });

  return (
    <div className="flex min-h-0 flex-1">
      <WorkbenchList
        selected={selId}
        detailOpen={!!selId || overview}
        hints={[
          ["↑↓", "move"],
          ["/", "search"],
          ["esc", "overview"],
        ]}
        header={
          <>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <SearchInput
                  ref={searchRef}
                  placeholder="Search combos"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  shortcut="/"
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                icon="add"
                onClick={() => setNaming({ mode: "new" })}
              >
                New
              </Button>
            </div>
            <Segmented<Scope>
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: api.combos ? `All · ${all.length}` : "All" },
                {
                  value: "attention",
                  label: `Needs attention${attention.length ? ` · ${attention.length}` : ""}`,
                },
              ]}
            />
          </>
        }
      >
        <WorkbenchOverviewRow
          icon="layers"
          subtitle="How many combos, which need attention"
          onClick={openOverview}
        />
        {!api.combos ? (
          <ListSkeleton rows={4} />
        ) : (
          <>
            {shown.length > 0 && (
              <ListGroup title="Combos" count={shown.length}>
                {shown.map((c) => (
                  <ListRow
                    key={c.id}
                    id={c.name}
                    active={c.name === selId}
                    onClick={() => select(c.name === selId ? null : c.name)}
                    leading={<Icon name="layers" size={18} className="text-text-muted" />}
                    title={<span className="font-mono">{c.name}</span>}
                    subtitle={`${STRATEGY_LABEL[api.strategyOf(c.name)]} · ${c.models.length} step${
                      c.models.length === 1 ? "" : "s"
                    }`}
                    trailing={<StatusDot status={statusOf(api, c)} />}
                    version={statusOf(api, c)}
                  />
                ))}
              </ListGroup>
            )}
            {!shown.length && (
              <p className="px-3 py-6 text-[13px] text-text-muted">
                {all.length
                  ? q
                    ? `Nothing matches “${q}”.`
                    : "Nothing needs attention."
                  : "No combos yet. A combo is a list of models tried in order, or in turns, under one name."}
              </p>
            )}
            <ListGroup title="For every model">
              <ListRow
                id={VISION}
                active={vision}
                onClick={() => select(vision ? null : VISION)}
                leading={<Icon name="visibility" size={18} className="text-text-muted" />}
                title="Vision fallback"
              />
            </ListGroup>
          </>
        )}
      </WorkbenchList>

      <WorkbenchDetail
        detailOpen={!!selId || overview}
        backLabel="All combos"
        onBack={() => select(null)}
      >
        {vision ? (
          <VisionAdapter />
        ) : current ? (
          <ComboDetail
            key={current.id}
            combo={current}
            api={api}
            onBack={() => select(null)}
            onRename={() => setNaming({ mode: "rename", combo: current })}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
            <div>
              <h1 className="font-display text-3xl">Combos</h1>
              <p className="mt-1 text-[13px] text-text-muted">
                {api.combos ? (
                  <>
                    <strong className="font-medium text-text">
                      {all.length} combo{all.length === 1 ? "" : "s"}
                    </strong>
                    {attention.length > 0 && ` · ${attention.length} need attention`}
                    {failing > 0 && ` · ${failing} with every step down`}
                  </>
                ) : (
                  "Loading combos…"
                )}
              </p>
            </div>
            <EmptyState icon="layers">
              A combo is a list of models under one name. Apps send that name as the model; regent
              tries the steps in order, in turns, or all at once. Pick one to see its steps.
            </EmptyState>
          </div>
        )}
      </WorkbenchDetail>

      {naming && (
        <NameDialog
          initial={naming.mode === "rename" ? naming.combo.name : ""}
          title={naming.mode === "rename" ? "Rename combo" : "New combo"}
          taken={(n) =>
            all.some((c) => c.name === n && (naming.mode === "new" || c.id !== naming.combo.id))
          }
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

function NameDialog({
  initial,
  title,
  taken,
  onClose,
  onSave,
}: {
  initial: string;
  title: string;
  taken: (n: string) => boolean;
  onClose: () => void;
  onSave: (n: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = name.trim();
  const problem = !n
    ? null
    : !VALID_NAME.test(n)
      ? "Letters, numbers, - _ and . only"
      : taken(n)
        ? "Another combo has that name"
        : null;
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
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={initial ? "check" : "add"}
            loading={busy}
            disabled={!n || !!problem || n === initial}
            onClick={() => void submit()}
          >
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
    </Dialog>
  );
}
