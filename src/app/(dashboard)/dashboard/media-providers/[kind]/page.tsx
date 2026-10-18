import { redirect } from "next/navigation";
import { mediaHref } from "../workbench/href";

// Old per-kind pages now live in the workbench.
export default async function MediaKindRedirect({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  redirect(mediaHref({ kind }));
}
