import { runRequestPipeline } from "@/lib/request-pipelines/run.js";
import { validatePipelines } from "@/lib/request-pipelines/config.js";

export async function POST(request) {
  try {
    const { pipeline, body } = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Preview requires a JSON request object");
    }
    const pipelines = validatePipelines([pipeline]);
    return Response.json(await runRequestPipeline(body, pipeline.name, pipelines));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
