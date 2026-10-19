"use client";

import { useState } from "react";
import { Button, ConfirmDialog, SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import {
  DEFAULT_PLAN_ID,
  PlanDialog,
  PlanEditor,
  planSummary,
  usePricePlans,
  type PricePlan,
} from "@/ui/pricing/PricePlan";
import { notify } from "./useSettings";

/**
 * Settings → Customer pricing: the default plan (keys without one) and the named plans.
 * Keys pick their plan on Endpoint & Key.
 */
export function PricePlans() {
  const { list, save, remove } = usePricePlans();
  const [editing, setEditing] = useState<null | { id: string | null; plan: PricePlan | null }>(
    null,
  );
  const [deleting, setDeleting] = useState<null | { id: string; name: string; keys: number }>(null);
  const [busy, setBusy] = useState(false);
  const named = Object.entries(list?.plans ?? {}).filter(([id]) => id !== DEFAULT_PLAN_ID);
  const keysOn = (id: string) => Object.values(list?.keyPlans ?? {}).filter((p) => p === id).length;

  return (
    <SettingsSection id="pricing" icon="sell" title="Customer pricing">
      {!list ? (
        <SettingRowSkeleton />
      ) : (
        <>
          <SettingRow
            stack
            title="Default plan"
            hint="What keys without a plan of their own are charged. Cost comes from Pricing; charge is what the customer pays, recorded with each request."
          >
            <PlanEditor
              key={JSON.stringify(list.plans[DEFAULT_PLAN_ID])}
              initial={list.plans[DEFAULT_PLAN_ID] ?? null}
              fixedName="Default"
              saveLabel="Save default plan"
              onSave={async (p) => {
                await save(DEFAULT_PLAN_ID, p);
                notify().success("Default plan saved");
              }}
            />
          </SettingRow>
          <SettingRow
            stack
            title="Plans"
            hint="Reusable tiers such as Starter or Pro. Editing one changes the price for every key on it."
          >
            <div className="space-y-2">
              {named.length === 0 && (
                <div className="text-[12px] text-text-muted">No plans yet.</div>
              )}
              {named.map(([id, p]) => (
                <div
                  key={id}
                  className="flex items-center gap-3 rounded-lg bg-bg-alt px-3 py-2 max-md:flex-wrap"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.name}</div>
                    <div className="text-[11px] text-text-muted">
                      {planSummary(p)} · {keysOn(id)} key{keysOn(id) === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex gap-1 max-md:w-full">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="max-md:flex-1"
                      onClick={() => setEditing({ id, plan: p })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="max-md:flex-1"
                      onClick={() => setDeleting({ id, name: p.name, keys: keysOn(id) })}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                icon="add"
                className="max-md:w-full"
                onClick={() => setEditing({ id: null, plan: null })}
              >
                New plan
              </Button>
            </div>
          </SettingRow>
        </>
      )}

      {editing && (
        <PlanDialog
          title={editing.id ? `Plan "${editing.plan?.name ?? ""}"` : "New plan"}
          initial={editing.plan}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            await save(editing.id, p);
            notify().success("Plan saved");
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        message={
          deleting?.keys
            ? `${deleting.keys} key${deleting.keys === 1 ? " moves" : "s move"} to the default plan. Past charges don't change.`
            : "No key uses it. Past charges don't change."
        }
        confirmText="Delete plan"
        loading={busy}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await remove(deleting.id);
            notify().success("Plan deleted");
          } finally {
            setBusy(false);
            setDeleting(null);
          }
        }}
      />
    </SettingsSection>
  );
}
