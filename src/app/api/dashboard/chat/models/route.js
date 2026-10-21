// Playground model filter: which of the given model ids the picked key may call (the
// same resolution /v1/models uses for a restricted key). Session + same-origin JSON,
// like the chat route. Lookup only: it never creates a key.
import { checkPlaygroundRequest } from "@/lib/playground/handler.js";
import { allowedModelsFor, isValidKeyId } from "@/lib/playground/keys.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const gate = await checkPlaygroundRequest(request);
  if (gate.error) return gate.error;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }
  if (!isValidKeyId(body?.keyId) || !Array.isArray(body?.models))
    return Response.json({ error: { message: "keyId and models are required" } }, { status: 400 });
  const models = await allowedModelsFor(body.keyId, body.models);
  if (!models) return Response.json({ error: { message: "API key not found" } }, { status: 404 });
  return Response.json({ models }, { headers: { "Cache-Control": "no-store" } });
}
