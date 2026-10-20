"use client";

import { useState } from "react";
import { Button, CopyButton, IconButton, Panel, Select, Switch, Tag } from "@/ui";
import { cn } from "@/ui/cn";
import { ModelSelectModal } from "@/shared/components";
import { BudgetDialog, BudgetMeter, type Budget, type BudgetEntry } from "@/ui/budget/Budget";
import { DEFAULT_PLAN_ID, PlanDialog, planSummary, type PricePlan } from "@/ui/pricing/PricePlan";
import type { ApiKey, KeyAccess } from "./useEndpoint";

const mask = (k: string) => (k.length <= 10 ? k : `${k.slice(0, 6)}••••••••${k.slice(-4)}`);

/** One API key: name, masked value, on/off, and which combos/models it may call. */
export function KeyCard({
  k,
  onActive,
  onAccess,
  onDelete,
  confirm,
  budget,
  onBudgetSave,
  onBudgetRemove,
  plans,
  resolved,
  planId,
  onPlanAssign,
  onPlanSave,
}: {
  k: ApiKey;
  onActive: (on: boolean) => void;
  onAccess: (a: KeyAccess) => void;
  onDelete: () => void;
  budget?: BudgetEntry | null;
  onBudgetSave: (b: Partial<Budget>) => Promise<void>;
  onBudgetRemove: () => Promise<void>;
  /** Every plan by id ("default" included); null while loading. */
  plans: Record<string, PricePlan> | null;
  resolved?: Record<string, string | null>;
  planId: string;
  onPlanAssign: (planId: string) => Promise<void>;
  /** `id` null creates a plan and returns its id. */
  onPlanSave: (id: string | null, plan: PricePlan) => Promise<string>;
  confirm: (opts: {
    title: string;
    message: string;
    confirmText: string;
    icon?: string;
    danger?: boolean;
    run: () => void;
  }) => void;
}) {
  const [show, setShow] = useState(false);
  const [editBudget, setEditBudget] = useState(false);
  const [editPlan, setEditPlan] = useState<null | "current" | "new">(null);
  const plan = plans?.[planId] ?? plans?.[DEFAULT_PLAN_ID] ?? null;
  const [picker, setPicker] = useState<null | {
    providers: unknown[];
    aliases: Record<string, string>;
  }>(null);
  const access = k.access ?? { restricted: false, allow: [] };
  const setAllow = (allow: string[]) => onAccess({ restricted: true, allow });

  const openPicker = async () => {
    const get = (u: string): Promise<Record<string, any>> =>
      fetch(u)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    const [p, a] = await Promise.all([get("/api/providers"), get("/api/models/alias")]);
    setPicker({ providers: p.connections ?? [], aliases: a.aliases ?? {} });
  };

  return (
    <Panel className={cn("flex min-w-0 flex-col gap-3 p-4", !k.isActive && "opacity-70")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{k.name}</div>
          <div className="text-[11px] text-text-subtle">
            {k.isActive ? "Active" : "Paused"} · added {new Date(k.createdAt).toLocaleDateString()}
          </div>
        </div>
        <Switch
          checked={k.isActive}
          label={k.isActive ? "Pause key" : "Resume key"}
          onChange={(on) =>
            on
              ? onActive(true)
              : confirm({
                  title: `Pause ${k.name}?`,
                  message: "Requests using this key are refused until you turn it back on.",
                  confirmText: "Pause key",
                  icon: "pause",
                  danger: true,
                  run: () => onActive(false),
                })
          }
        />
      </div>

      <div className="flex min-w-0 items-center gap-0.5 rounded-lg bg-bg-alt py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-muted">
          {show ? k.key : mask(k.key)}
        </code>
        <IconButton
          icon={show ? "visibility_off" : "visibility"}
          label={show ? "Hide key" : "Show key"}
          onClick={() => setShow(!show)}
        />
        <CopyButton value={k.key} label="Copy key" />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-text-muted">
            {access.restricted ? "Can only call" : "Can call every model"}
          </span>
          <Switch
            checked={access.restricted}
            label="Limit models"
            onChange={(on) =>
              on
                ? confirm({
                    title: `Limit ${k.name}?`,
                    message:
                      "It can only call the combos and models you add. Until you add one, it can call nothing.",
                    confirmText: "Limit models",
                    icon: "lock",
                    run: () => onAccess({ restricted: true, allow: access.allow }),
                  })
                : onAccess({ restricted: false, allow: access.allow })
            }
          />
        </div>
        {access.restricted && (
          <div className="flex flex-wrap items-center gap-1">
            {access.allow.length === 0 && <Tag tone="danger">Nothing allowed yet</Tag>}
            {access.allow.map((m) => (
              <Tag key={m} mono tone="accent" className="gap-0.5 pr-1">
                {m}
                <button
                  type="button"
                  aria-label={`Remove ${m}`}
                  onClick={() => setAllow(access.allow.filter((x) => x !== m))}
                  className="grid size-4 place-items-center rounded hover:bg-accent/15"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
                    close
                  </span>
                </button>
              </Tag>
            ))}
            <button
              type="button"
              onClick={() => void openPicker()}
              className="rounded-md border border-dashed border-border-strong px-1.5 py-0.5 text-[11px] text-text-muted hover:border-accent hover:text-accent-text"
            >
              Add…
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-text-muted">Price plan</span>
          <Button variant="ghost" size="sm" disabled={!plan} onClick={() => setEditPlan("current")}>
            Edit plan
          </Button>
        </div>
        <Select
          aria-label={`Price plan for ${k.name}`}
          value={plans ? planId : ""}
          disabled={!plans}
          onChange={(e) =>
            e.target.value === "__new" ? setEditPlan("new") : void onPlanAssign(e.target.value)
          }
        >
          {plans ? (
            <>
              {Object.entries(plans).map(([id, p]) => (
                <option key={id} value={id}>
                  {id === DEFAULT_PLAN_ID ? "Default plan" : p.name}
                </option>
              ))}
              <option value="__new">New plan…</option>
            </>
          ) : (
            <option value="">Loading…</option>
          )}
        </Select>
        {plan && <div className="text-[11px] text-text-subtle">{planSummary(plan)}</div>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-text-muted">{budget ? "Budget" : "No budget"}</span>
          <button
            type="button"
            onClick={() => setEditBudget(true)}
            className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text max-md:min-h-10 max-md:px-3"
          >
            {budget ? "Edit" : "Set budget"}
          </button>
        </div>
        {budget && <BudgetMeter entry={budget} />}
      </div>

      <div className="mt-auto flex justify-end border-t border-border pt-2">
        <button
          type="button"
          onClick={() =>
            confirm({
              title: `Delete ${k.name}?`,
              message: "Apps using this key stop working. This can't be undone.",
              confirmText: "Delete key",
              danger: true,
              run: onDelete,
            })
          }
          className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-danger-soft hover:text-danger-text max-md:min-h-10 max-md:px-3"
        >
          Delete
        </button>
      </div>

      {editBudget && (
        <BudgetDialog
          title={`Budget for "${k.name}"`}
          initial={budget?.budget ?? null}
          unpriced={budget?.status.unpricedModels}
          forKey
          onClose={() => setEditBudget(false)}
          onSave={onBudgetSave}
          onRemove={budget ? onBudgetRemove : undefined}
        />
      )}

      {editPlan && (
        <PlanDialog
          title={
            editPlan === "new"
              ? `New plan for "${k.name}"`
              : planId === DEFAULT_PLAN_ID
                ? "Default plan"
                : `Plan "${plan?.name ?? ""}"`
          }
          description={
            editPlan === "current"
              ? planId === DEFAULT_PLAN_ID
                ? "Applies to every key without a plan of its own."
                : "Changes apply to every key on this plan."
              : undefined
          }
          initial={editPlan === "new" ? null : plan}
          resolved={resolved}
          fixedName={editPlan === "current" && planId === DEFAULT_PLAN_ID ? "Default" : undefined}
          onClose={() => setEditPlan(null)}
          onSave={async (p) => {
            if (editPlan === "new") await onPlanAssign(await onPlanSave(null, p));
            else await onPlanSave(planId, p);
          }}
        />
      )}

      {picker && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicker(null)}
          onSelect={(m: { value?: string }) => {
            const v = m?.value;
            if (v && !access.allow.some((e) => e.toLowerCase() === v.toLowerCase()))
              setAllow([...access.allow, v]);
          }}
          onDeselect={(m: { value?: string }) =>
            setAllow(access.allow.filter((e) => e.toLowerCase() !== String(m?.value).toLowerCase()))
          }
          activeProviders={picker.providers}
          modelAliases={picker.aliases}
          title={`Allowed for "${k.name}"`}
          addedModelValues={access.allow}
          closeOnSelect={false}
        />
      )}
    </Panel>
  );
}
