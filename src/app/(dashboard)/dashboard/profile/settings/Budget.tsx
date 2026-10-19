"use client";

import { useState } from "react";
import { SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import { BudgetEditor, BudgetMeter, useBudgets } from "@/ui/budget/Budget";
import { notify } from "./useSettings";

/** Settings → Budget: one budget across every API key. Per-key budgets live on Endpoint & Key. */
export function GlobalBudget() {
  const { list, save, remove } = useBudgets();
  const [version, setVersion] = useState(0);
  const entry = list?.global ?? null;

  return (
    <SettingsSection id="budget" icon="savings" title="Budget">
      {!list ? (
        <SettingRowSkeleton />
      ) : (
        <>
          <SettingRow
            stack
            title="All API keys"
            hint="Counts every request through the gateway. Set per-customer budgets on each key under Endpoint & Key. Alerts go to the admin email under Notifications."
          >
            {entry ? (
              <BudgetMeter entry={entry} />
            ) : (
              <span className="text-[12px] text-text-muted">No global budget.</span>
            )}
          </SettingRow>
          <div className="py-4">
            <BudgetEditor
              key={`${version}:${entry ? "set" : "none"}`}
              initial={entry?.budget ?? null}
              forKey={false}
              onSave={async (b) => {
                await save("global", b);
                notify().success("Budget saved");
              }}
              onRemove={async () => {
                await remove("global");
                setVersion((v) => v + 1);
                notify().success("Budget removed");
              }}
            />
          </div>
        </>
      )}
    </SettingsSection>
  );
}
