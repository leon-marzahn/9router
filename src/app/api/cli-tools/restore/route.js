import { NextResponse } from "next/server";
import { listBackups, restoreBackups } from "../configFile.js";

// "Restore previous": copy back the rolling <file>.regent.bak backups that the last
// Apply/Reset of a tool left behind. Local-only like the rest of /api/cli-tools/.

// Only a lookup key into the backup manifest; the file paths come from the manifest.
const toolIdFrom = (value) => (typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value) ? value : null);

export async function GET(request) {
  const toolId = toolIdFrom(new URL(request.url).searchParams.get("toolId"));
  if (!toolId) return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
  try {
    const files = await listBackups(toolId);
    return NextResponse.json({ available: files.length > 0, files });
  } catch (error) {
    console.log("Error listing cli-tool backups:", error);
    return NextResponse.json({ error: "Failed to list backups" }, { status: 500 });
  }
}

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const toolId = toolIdFrom(body?.toolId);
  if (!toolId) return NextResponse.json({ error: "Unknown tool" }, { status: 400 });
  try {
    const files = await restoreBackups(toolId);
    if (files.length === 0) return NextResponse.json({ error: "No backup to restore" }, { status: 404 });
    return NextResponse.json({ success: true, files });
  } catch (error) {
    console.log("Error restoring cli-tool backup:", error);
    return NextResponse.json({ error: "Failed to restore backup" }, { status: 500 });
  }
}
