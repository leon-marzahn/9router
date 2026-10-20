import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { withProviderNames } from "@/lib/providerName.js";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate,
 * summary=1 (drop the captured request/response bodies — for live lists; fetch one by id for bodies)
 */
const BODY_FIELDS = ["request", "providerRequest", "providerResponse", "response"];
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);
    if (searchParams.get("summary") === "1") {
      result.details = result.details.map((d) => {
        const lean = { ...d };
        for (const f of BODY_FIELDS) delete lean[f];
        return lean;
      });
    }
    // Custom nodes by name in the Live list, never their internal id.
    result.details = await withProviderNames(result.details);

    // Dashboard access is enforced by dashboardGuard. Return the captured
    // payloads for inspection; credential headers are sanitized before storage.
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
