import { redirect } from "next/navigation";
import { mediaHref } from "../../workbench/href";

export default async function MediaProviderRedirect({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  redirect(mediaHref({ kind, provider: decodeURIComponent(id) }));
}
