import { redirect } from "next/navigation";

// Old per-tool URLs open the tool in the workbench.
export default async function ToolDetailPage({ params }) {
  const { toolId } = await params;
  redirect(`/dashboard/cli-tools?tool=${encodeURIComponent(toolId)}`);
}
