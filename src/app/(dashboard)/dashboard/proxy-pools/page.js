import { Suspense } from "react";
import { ProxyPoolsWorkbench } from "./workbench/ProxyPoolsWorkbench";

export default function ProxyPoolsPage() {
  return (
    <Suspense>
      <ProxyPoolsWorkbench />
    </Suspense>
  );
}
