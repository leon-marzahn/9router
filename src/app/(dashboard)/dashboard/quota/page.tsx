"use client";

import { Suspense } from "react";
import { EmptyState, Skeleton } from "@/ui";
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
  if (!q.accounts) return <QuotaSkeleton />;
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

/** Same shape as the workbench (list pane + timeline + capacity cards) so nothing jumps on load. */
function QuotaSkeleton() {
  return (
    <div className="flex h-full min-h-0" aria-busy aria-label="Loading quota">
      <aside className="w-[360px] shrink-0 space-y-4 border-r border-border bg-pane p-3">
        <Skeleton className="h-9 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
        {[3, 2].map((rows, g) => (
          <div key={g} className="space-y-3 pt-2">
            <div className="flex items-center gap-2 px-2">
              <Skeleton className="size-5 rounded-md" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="ml-7 space-y-2 px-2.5">
                <Skeleton className="h-3.5 w-40" />
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-1 rounded-full" />
                  <Skeleton className="h-1 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </aside>
      <section className="min-w-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-10 px-8 py-8">
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-[98px] rounded-2xl" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-6 w-36" />
            <div className="grid gap-4 lg:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-36 rounded-2xl" />
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
