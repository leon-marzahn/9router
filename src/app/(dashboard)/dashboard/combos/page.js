import { Suspense } from "react";
import { CombosWorkbench } from "./workbench/CombosWorkbench";

export default function CombosPage() {
  return (
    <Suspense>
      <CombosWorkbench />
    </Suspense>
  );
}
