"use client";

import { Suspense } from "react";
import CurrentPipelines from "./CurrentPipelines";
import { PipelinesPrototype } from "./prototype-variants/PipelinesPrototype";

export default function RequestPipelinesPage() {
  return (
    <Suspense>
      {/* PROTOTYPE: layout variants (see prototype-variants/) */}
      <PipelinesPrototype current={<CurrentPipelines />} />
    </Suspense>
  );
}
