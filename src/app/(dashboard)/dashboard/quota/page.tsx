"use client";

import { Suspense } from "react";
import { EmptyState } from "@/ui";
import { QuotaWorkbench } from "./workbench/QuotaWorkbench";
import { useQuota } from "./workbench/useQuota";

export default function QuotaPage() {
  return (
    <Suspense>
      <Quota />
    </Suspense>
  );
}

function Quota() {
  const q = useQuota();
  if (q.error && !q.accounts) return <EmptyState icon="error">{q.error}</EmptyState>;
  if (!q.accounts) return <p className="p-8 text-sm text-text-muted">Loading quota…</p>;
  if (!q.accounts.length)
    return (
      <div className="p-8">
        <EmptyState icon="data_usage">
          No accounts report quota yet. Connect a Claude, Codex, Antigravity, Kiro or Copilot
          account (and similar) in Providers to track its limits here.
        </EmptyState>
      </div>
    );
  return <QuotaWorkbench accounts={q.accounts} actions={q} onRefreshAll={q.refreshAll} />;
}
