"use client";

import { EmptyState } from "@/ui";
import { QuotaWorkbench } from "./QuotaWorkbench";
import { useQuota } from "./useQuota";

export function QuotaPage({ initial }: { initial: Record<string, unknown>[] }) {
  const q = useQuota(initial);
  if (q.error && !q.accounts) return <EmptyState icon="error">{q.error}</EmptyState>;
  if (q.accounts && !q.accounts.length)
    return (
      <div className="p-8">
        <EmptyState icon="data_usage">
          No accounts report quota yet. Connect a Claude, Codex, Antigravity, Kiro or Copilot
          account (and similar) in Providers to track its limits here.
        </EmptyState>
      </div>
    );
  return (
    <QuotaWorkbench
      accounts={q.accounts ?? []}
      loading={!q.accounts}
      actions={q}
      onRefreshAll={q.refreshAll}
    />
  );
}
