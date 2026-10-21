// Playground model filter: which of the given model ids the picked key may call (the
// same resolution /v1/models uses for a restricted key). Behind the dashboard guard.
import { allowedModelsFor, isValidKeyId } from "@/lib/playground/keys.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
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
