import { Suspense } from "react";
import { PipelinesWorkbench } from "./workbench/PipelinesWorkbench";

export default function RequestPipelinesPage() {
  return (
    <Suspense>
      <PipelinesWorkbench />
    </Suspense>
  );
}
