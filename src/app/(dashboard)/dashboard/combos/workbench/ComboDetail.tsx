"use client";

import { useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Button,
  Icon,
  IconButton,
  MenuItem,
  MenuSeparator,
  ModelPicker,
  Panel,
  Popover,
  ProviderLogo,
  Segmented,
  Tag,
  ConfirmDialog,
  CopyButton,
  StatusDot,
  StatusLabel,
} from "@/ui";
import { cn } from "@/ui/cn";
import { ModelSelectModal } from "@/shared/components";
import { STEP_LABEL, STEP_STATUS, splitStep, stepDetail } from "./steps";
import type { Combo, CombosApi, SmartPolicy, Strategy } from "./useCombos";
import { useRouterModels } from "./routerModels";

const HOW: Record<Strategy, string> = {
  fallback:
    "Top to bottom. Steps that are resting or have no account are skipped without trying them.",
  "round-robin": "Takes turns between the steps, a few requests each (set in Settings → Routing).",
  "per-chat":
    "Each conversation sticks to one step, so its prompt cache stays warm. New conversations spread across the steps. If a conversation's step fails, it moves to another one.",
  smart:
    "A router model reads each new message and picks the step that suits it best. A conversation keeps its step so the prompt cache stays warm.",
  fusion: "Asks every step at once, then a judge model merges the answers. Slower and costs more.",
};

const POLICY_HOW: Record<SmartPolicy, string> = {
  smart:
    "Each message is checked; the conversation moves only when the router is sure the task changed.",
  strict:
    "The first message picks the step and the conversation stays there. No router call after that, so no extra latency or cost.",
  "per-turn":
    "Every message is routed on its own. Best fit per message, but the prompt cache goes cold when it moves.",
};

const THRESHOLDS = ["0.7", "0.8", "0.9"] as const;

export function ComboDetail({
  combo,
  api,
  onBack,
  onRename,
}: {
  combo: Combo & { shadows?: string | null };
  api: CombosApi;
  onBack: () => void;
  onRename: () => void;
}) {
  const strategy = api.strategyOf(combo.name);
  const settings = api.settingsFor(combo.name);
  const stick =
    typeof settings.stickAfterFallback === "boolean"
      ? settings.stickAfterFallback
      : strategy === "per-chat";
  const [picker, setPicker] = useState<null | "steps" | "judge">(null);
  const routerGroups = useRouterModels(strategy === "smart");
  const policy: SmartPolicy = settings.smartPolicy ?? "smart";
  const threshold = String(
    THRESHOLDS.find((t) => Number(t) === settings.confidenceThreshold) ?? "0.8",
  ) as (typeof THRESHOLDS)[number];
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [del, setDel] = useState(false);
  const models = combo.models;
  const next =
    strategy === "fallback"
      ? models.findIndex((m) => !["cooling", "off"].includes(api.readiness[m]?.state ?? "ready"))
      : -1;

  const setModels = (m: string[]) => void api.update(combo.id, { models: m }).catch(() => {});
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = models.map((m, i) => `${i}:${m}`);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setModels(arrayMove(models, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-3xl">{combo.name}</h1>
          <p className="mt-1 text-[13px] text-text-muted">
            Send <code className="font-mono">{combo.name}</code> as the model, or{" "}
            <code className="font-mono">combo/{combo.name}</code> to always mean this combo.
          </p>
        </div>
        <span className="flex items-center gap-1">
          <CopyButton value={combo.name} label="Copy model name" />
          <IconButton ref={menuRef} icon="more_horiz" label="More" onClick={() => setMenu(!menu)} />
        </span>
        <Popover
          open={menu}
          onClose={() => setMenu(false)}
          anchorRef={menuRef}
          side="bottom-end"
          className="w-48 py-1"
        >
          <MenuItem
            icon="edit"
            onClick={() => {
              setMenu(false);
              onRename();
            }}
          >
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="delete"
            danger
            onClick={() => {
              setMenu(false);
              setDel(true);
            }}
          >
            Delete
          </MenuItem>
        </Popover>
      </header>

      {combo.shadows && (
        <p className="flex items-start gap-1.5 text-[12px] text-warning-text">
          <Icon name="info" size={14} className="mt-px shrink-0" />
          <span>
            Same name as the model <code className="font-mono">{combo.shadows}</code>, so requests
            for <code className="font-mono">{combo.name}</code> go through this combo. Fine if
            that&rsquo;s the point; otherwise rename it.
          </span>
        </p>
      )}

      <Panel className="divide-y divide-border px-4">
        <div className="space-y-3 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 sm:max-w-sm">
              <div className="text-[13px] font-medium">How it picks</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
                {HOW[strategy]}
              </div>
            </div>
            <Segmented<Strategy>
              className="shrink-0"
              value={strategy}
              onChange={(v) => void api.setSettings(combo.name, { fallbackStrategy: v })}
              options={[
                { value: "fallback", label: "In order" },
                { value: "round-robin", label: "Turns" },
                { value: "per-chat", label: "Per chat" },
                { value: "smart", label: "Smart" },
                { value: "fusion", label: "Ask all" },
              ]}
            />
          </div>
        </div>
        {(strategy === "fallback" || strategy === "per-chat") && (
          <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 sm:max-w-sm">
              <div className="text-[13px] font-medium">After a fallback</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
                {stick
                  ? "The conversation stays on the step that answered, so its cache stays warm, even once an earlier step is back. Resets after an hour without requests."
                  : strategy === "fallback"
                    ? "Every request starts again from the top, so the conversation goes back to your first step as soon as it's ready."
                    : "The conversation goes back to its own step as soon as that step is ready again."}
              </div>
            </div>
            <Segmented<"stay" | "back">
              className="shrink-0"
              value={stick ? "stay" : "back"}
              onChange={(v) =>
                void api.setSettings(combo.name, { stickAfterFallback: v === "stay" })
              }
              options={[
                { value: "stay", label: "Stay" },
                { value: "back", label: "Go back up" },
              ]}
            />
          </div>
        )}
        {strategy === "smart" && (
          <>
            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 sm:max-w-sm">
                <div className="text-[13px] font-medium">Router model</div>
                {settings.routerModel ? (
                  <div className="truncate font-mono text-[12px] text-text-muted">
                    {settings.routerModel}
                  </div>
                ) : (
                  <div className="mt-0.5 flex items-start gap-1.5 text-[12px] text-warning-text">
                    <Icon name="info" size={14} className="mt-px shrink-0" />
                    <span>Not chosen yet, so the steps are tried in order.</span>
                  </div>
                )}
                <div className="mt-1 text-[12px] leading-relaxed text-text-muted">
                  A System One model (Ollama Clef, OpenCode Jev, Cloudflare). It sees the latest
                  message, up to 2,000 characters, and its tokens count toward the calling key.
                </div>
              </div>
              <span className="flex shrink-0 gap-1">
                {settings.routerModel && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void api.setSettings(combo.name, { routerModel: undefined })}
                  >
                    Remove
                  </Button>
                )}
                <ModelPicker
                  className="max-w-56"
                  groups={routerGroups ?? []}
                  disabled={!routerGroups}
                  value={settings.routerModel ?? null}
                  placeholder={routerGroups?.length === 0 ? "No System One account" : "Choose"}
                  title="Router model"
                  onChange={(id) => void api.setSettings(combo.name, { routerModel: id })}
                />
              </span>
            </div>
            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 sm:max-w-sm">
                <div className="text-[13px] font-medium">Within a conversation</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
                  {POLICY_HOW[policy]} Conversations are kept apart per API key.
                </div>
              </div>
              <Segmented<SmartPolicy>
                className="shrink-0"
                value={policy}
                onChange={(v) => void api.setSettings(combo.name, { smartPolicy: v })}
                options={[
                  { value: "smart", label: "Re-check" },
                  { value: "strict", label: "Lock" },
                  { value: "per-turn", label: "Every message" },
                ]}
              />
            </div>
            {policy !== "strict" && (
              <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 sm:max-w-sm">
                  <div className="text-[13px] font-medium">Follow the router when it is</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
                    Below this confidence the router&rsquo;s pick is ignored: a new conversation
                    starts at the first step, an ongoing one stays where it is.
                  </div>
                </div>
                <Segmented<(typeof THRESHOLDS)[number]>
                  className="shrink-0"
                  value={threshold}
                  onChange={(v) =>
                    void api.setSettings(combo.name, { confidenceThreshold: Number(v) })
                  }
                  options={THRESHOLDS.map((t) => ({
                    value: t,
                    label: `${Math.round(Number(t) * 100)}% sure`,
                  }))}
                />
              </div>
            )}
          </>
        )}
        {strategy === "fusion" && (
          <div className="flex items-center justify-between gap-3 py-4">
            <div>
              <div className="text-[13px] font-medium">Judge</div>
              <div className="font-mono text-[12px] text-text-muted">
                {settings.judgeModel || `${models[0] ?? "—"} (first step)`}
              </div>
            </div>
            <span className="flex gap-1">
              {settings.judgeModel && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.setSettings(combo.name, { judgeModel: undefined })}
                >
                  Use first step
                </Button>
              )}
              <Button size="sm" icon="gavel" onClick={() => setPicker("judge")}>
                Choose
              </Button>
            </span>
          </div>
        )}
      </Panel>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-medium">
            Steps <span className="text-text-subtle">{models.length}</span>
          </h2>
          <Button size="sm" icon="add" onClick={() => setPicker("steps")}>
            Add step
          </Button>
        </div>
        {models.length === 0 ? (
          <Panel className="p-6 text-center text-[13px] text-text-muted">
            No steps yet. Add the models this combo should use.
          </Panel>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ol className="space-y-2">
                {models.map((m, i) => (
                  <StepRow
                    key={ids[i]}
                    id={ids[i]}
                    index={i}
                    step={m}
                    api={api}
                    isNext={i === next}
                    onRemove={() => setModels(models.filter((_, j) => j !== i))}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
        {models.length > 1 && <p className="text-[11px] text-text-subtle">Drag to reorder.</p>}
      </section>

      {picker && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicker(null)}
          title={picker === "judge" ? "Judge model" : `Add steps to ${combo.name}`}
          closeOnSelect={picker === "judge"}
          addedModelValues={picker === "steps" ? models : []}
          onSelect={(x: { value?: string }) => {
            if (!x?.value) return;
            if (picker === "judge") void api.setSettings(combo.name, { judgeModel: x.value });
            else if (x.value !== combo.name) setModels([...models, x.value]);
          }}
          onDeselect={(x: { value?: string }) =>
            picker === "steps" && setModels(models.filter((y) => y !== x?.value))
          }
        />
      )}
      <ConfirmDialog
        open={del}
        onClose={() => setDel(false)}
        title={`Delete ${combo.name}?`}
        message="Apps sending this combo as the model get an error until you point them somewhere else. Keys limited to it lose access."
        confirmText="Delete"
        onConfirm={() => {
          setDel(false);
          void api.remove(combo).then(onBack, () => {});
        }}
      />
    </div>
  );
}

function StepRow({
  id,
  index,
  step,
  api,
  isNext,
  onRemove,
}: {
  id: string;
  index: number;
  step: string;
  api: CombosApi;
  isNext: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const r = api.readiness[step];
  const tone = r?.state ?? (step.includes("/") ? "unknown" : "combo");
  const p = splitStep(step, r);
  const detail = stepDetail(r);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "relative z-10")}
    >
      <Panel
        className={cn(
          "flex items-center gap-3 p-3",
          isNext && "ring-1 ring-accent-ring",
          isDragging && "shadow-elev",
        )}
      >
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab touch-none text-text-subtle active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <Icon name="drag_indicator" size={18} />
        </button>
        <span className="w-4 text-center text-[12px] tabular-nums text-text-subtle">
          {index + 1}
        </span>
        {p.isCombo ? (
          <Icon name="layers" size={18} className="text-info-text" />
        ) : (
          <ProviderLogo providerId={p.providerId} name={p.providerName} size={18} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[13px]">{step}</div>
          <div className="truncate text-[12px] text-text-muted">
            {p.providerName}
            {detail ? ` · ${detail}` : ""}
          </div>
        </div>
        {isNext && (
          <Tag tone="accent" className="hidden sm:inline-flex">
            Next request
          </Tag>
        )}
        <StatusLabel
          status={STEP_STATUS[tone]}
          label={STEP_LABEL[tone]}
          className="hidden sm:inline-flex"
        />
        <span className="inline-flex sm:hidden">
          <StatusDot status={STEP_STATUS[tone]} />
          <span className="sr-only">{STEP_LABEL[tone]}</span>
        </span>
        <IconButton icon="close" label="Remove step" onClick={onRemove} />
      </Panel>
    </li>
  );
}
