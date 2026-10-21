// Playground key picker: id, name and state of each API key. Never the key secret.
// Session-gated here too (local-only with requireLogin off), not only by the guard.
import { checkPlaygroundRequest } from "@/lib/playground/handler.js";
import { listPlaygroundKeys } from "@/lib/playground/keys.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const gate = await checkPlaygroundRequest(request, { post: false });
  if (gate.error) return gate.error;
  try {
    return Response.json(
      { keys: await listPlaygroundKeys() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: { message: "Failed to list keys" } }, { status: 500 });
  }
}
