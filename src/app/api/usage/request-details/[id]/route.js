import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";

/**
 * GET /api/usage/request-details/:id — one captured request with its bodies.
 * Dashboard access is enforced by dashboardGuard (/api/usage is protected);
 * credential headers are sanitized before storage.
 */
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    if (!id || id.length > 200) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const detail = await getRequestDetailById(id);
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[API] Failed to get request detail:", error);
    return NextResponse.json({ error: "Failed to fetch request detail" }, { status: 500 });
  }
}
