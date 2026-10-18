import { runPipelines } from "@/lib/request-pipelines/run.js";

export async function POST(request) {
  try {
    const { pipeline, body } = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Preview requires a JSON request object");
    }
    // Previews never count towards the pipeline's usage stats.
    return Response.json(await runPipelines(body, [pipeline]));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
