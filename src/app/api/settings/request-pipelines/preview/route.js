import { runPipelines } from "@/lib/request-pipelines/run.js";
import { blankRequiredField } from "@/lib/request-pipelines/config.js";

/** A step the user is still filling in (a required field is blank). Malformed values still fail. */
const isIncomplete = (rule) => Boolean(rule && typeof rule === "object" && blankRequiredField(rule));

export async function POST(request) {
  try {
    const { pipeline, body } = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Preview requires a JSON request object");
    }
    // A newly added step starts blank: preview the others and report no stats for it
    // instead of rejecting the whole pipeline while the user is still typing.
    const rules = Array.isArray(pipeline?.rules) ? pipeline.rules : [];
    const ready = rules.filter((rule) => !isIncomplete(rule));
    if (ready.length === rules.length) {
      // Previews never count towards the pipeline's usage stats.
      return Response.json(await runPipelines(body, [pipeline]));
    }
    if (!ready.length) return Response.json({ body, stats: rules.map(() => null) });
    const result = await runPipelines(body, [{ ...pipeline, rules: ready }]);
    const queue = [...result.stats];
    return Response.json({ body: result.body, stats: rules.map((rule) => (isIncomplete(rule) ? null : queue.shift())) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
