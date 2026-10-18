import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

const repo = vi.hoisted(() => ({
  getCustomModels: vi.fn(async () => []),
  addCustomModel: vi.fn(async () => true),
  updateCustomModel: vi.fn(async (m) => m),
  deleteCustomModel: vi.fn(async () => {}),
}));
vi.mock("@/models", () => repo);

const { POST, PATCH } = await import("../../src/app/api/models/custom/route.js");
const req = (body) => new Request("http://localhost/api/models/custom", { method: "POST", body: JSON.stringify(body) });

describe("/api/models/custom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips a pasted provider prefix from the id", async () => {
    await POST(req({ providerAlias: "kr", id: " kr/claude-opus-4.6 " }));
    expect(repo.addCustomModel).toHaveBeenCalledWith(expect.objectContaining({ providerAlias: "kr", id: "claude-opus-4.6" }));
  });

  it("rejects an id that is only the prefix", async () => {
    const res = await POST(req({ providerAlias: "kr", id: "kr/" }));
    expect(res.status).toBe(400);
  });

  it("stores a trimmed, capped display name", async () => {
    await POST(req({ providerAlias: "kr", id: "m", name: `  ${"x".repeat(200)} ` }));
    expect(repo.addCustomModel.mock.calls[0][0].name).toBe("x".repeat(120));
  });

  it("PATCH passes the name through and keeps it when omitted", async () => {
    await PATCH(req({ providerAlias: "kr", id: "m", name: "Nice" }));
    expect(repo.updateCustomModel.mock.calls[0][0].name).toBe("Nice");
    await PATCH(req({ providerAlias: "kr", id: "m", name: 42 }));
    expect(repo.updateCustomModel.mock.calls[1][0].name).toBeUndefined();
  });
});
