import { Suspense } from "react";
import { CliToolsWorkbench } from "./workbench/CliToolsWorkbench";

export default function CLIToolsPage() {
  return (
    <Suspense>
      <CliToolsWorkbench />
    </Suspense>
  );
}
