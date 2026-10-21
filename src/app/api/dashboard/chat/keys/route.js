// Playground key picker: id, name and state of each API key. Never the key secret.
// Behind the dashboard guard (session required).
import { listPlaygroundKeys } from "@/lib/playground/keys.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(
      { keys: await listPlaygroundKeys() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: { message: "Failed to list keys" } }, { status: 500 });
  }
}
