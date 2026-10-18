import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, updateCustomModel, deleteCustomModel } from "@/models";
import { CAPACITY_META, isSttTransport } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// Accepted STT transport markers live in the shared whitelist
// (src/shared/constants/models STT_TRANSPORT_META) — the dashboard transport
// select and this validator must agree on one set, so neither owns a copy.
// Unknown or mistyped values are silently dropped, the same policy
// sanitizeCaps applies to capability keys.
function sanitizeTransport(transport, type) {
  if (type !== "stt" || !isSttTransport(transport)) return null;
  return transport.trim();
}

const MAX_NAME_LENGTH = 120;

// Optional display name: a trimmed string, capped. Anything else is dropped
// (undefined), so a PATCH without a name keeps the stored one.
function sanitizeName(name) {
  if (typeof name !== "string") return undefined;
  return name.trim().slice(0, MAX_NAME_LENGTH);
}

// The dialog knows the provider, so the id is the bare upstream model id. A
// pasted `<alias>/model` keeps working: strip the provider's own prefix.
function sanitizeId(id, providerAlias) {
  if (typeof id !== "string") return "";
  const clean = id.trim();
  const prefix = `${providerAlias}/`;
  return clean.startsWith(prefix) ? clean.slice(prefix.length).trim() : clean;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id: rawId, type, name, caps, transport } = await request.json();
    const id = sanitizeId(rawId, providerAlias);
    if (!providerAlias || typeof providerAlias !== "string" || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const cleanTransport = sanitizeTransport(transport, type || "llm");
    const added = await addCustomModel({ providerAlias, id, type: type || "llm", name: sanitizeName(name) || undefined, ...(cleanCaps ? { caps: cleanCaps } : {}), ...(cleanTransport ? { transport: cleanTransport } : {}) });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// PATCH /api/models/custom - Edit name/caps/transport of an existing custom model.
// The id, provider and type are the record's key, so they can't be changed.
export async function PATCH(request) {
  try {
    const { providerAlias, id, type, name, caps, transport } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const modelType = type || "llm";
    const model = await updateCustomModel({
      providerAlias,
      id,
      type: modelType,
      name: sanitizeName(name),
      caps: sanitizeCaps(caps),
      transport: sanitizeTransport(transport, modelType),
    });
    if (!model) return NextResponse.json({ error: "Custom model not found" }, { status: 404 });
    return NextResponse.json({ success: true, model });
  } catch (error) {
    console.log("Error updating custom model:", error);
    return NextResponse.json({ error: "Failed to update custom model" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
