import { redirect } from "next/navigation";
import { mediaHref } from "../../workbench/href";

// The workbench picks the kind from the combo itself.
export default async function MediaComboRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(mediaHref({ combo: decodeURIComponent(id) }));
}
