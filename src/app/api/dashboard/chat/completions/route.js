// Dashboard Playground chat. Session-only (behind the dashboard guard, re-checked in the
// handler), same-origin JSON only, no CORS and deliberately no OPTIONS handler.
// See src/lib/playground/handler.js for the security model.
import { handlePlaygroundChat } from "@/lib/playground/handler.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  return handlePlaygroundChat(request);
}
