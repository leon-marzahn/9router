import { getPipelineStats } from "@/lib/request-pipelines/run.js";

export const dynamic = "force-dynamic";

// Counters since the server started; nothing about request content is kept.
export async function GET() {
  return Response.json({ stats: getPipelineStats() });
}
