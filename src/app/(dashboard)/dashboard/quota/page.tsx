import { Suspense } from "react";
import { listQuotaConnections } from "@/lib/quotaConnections";
import { QuotaPage } from "./workbench/QuotaPage";

// Per-request: the account list comes from the local DB (fast), so the page is
// server-rendered with real rows; limits are fetched from each provider after.
// Dashboard routes are behind dashboardGuard.
export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await listQuotaConnections();
  return (
    <Suspense>
      <QuotaPage initial={initial} />
    </Suspense>
  );
}
