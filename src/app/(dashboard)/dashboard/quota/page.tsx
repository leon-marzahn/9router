"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { QuotaWorkbench } from "./workbench/QuotaWorkbench";
import type { Actions } from "./workbench/parts";

const noop = async () => {};
const IDLE: Actions = {
  refreshOne: () => {},
  setActive: noop,
  resetLimit: noop,
  setHidden: noop,
  autoPingFor: () => ({ reactive: false, schedule: null }),
  saveAutoPing: noop,
};

/** The page frame with skeletons where data goes; shown until the client code runs. */
const Loading = () => <QuotaWorkbench accounts={[]} loading actions={IDLE} onRefreshAll={noop} />;

// Client-only: the last view is read from localStorage on the first render.
const QuotaPage = dynamic(() => import("./workbench/QuotaPage").then((m) => m.QuotaPage), {
  ssr: false,
  loading: Loading,
});

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <QuotaPage />
    </Suspense>
  );
}
