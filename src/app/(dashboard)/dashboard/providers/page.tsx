import { Suspense } from "react";
import { ProvidersWorkbench } from "./workbench/ProvidersWorkbench";

export default function ProvidersPage() {
  return (
    <Suspense>
      <ProvidersWorkbench />
    </Suspense>
  );
}
