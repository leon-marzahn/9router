import { Suspense } from "react";
import { MediaWorkbench } from "./workbench/MediaWorkbench";

export default function MediaProvidersPage() {
  return (
    <Suspense>
      <MediaWorkbench />
    </Suspense>
  );
}
