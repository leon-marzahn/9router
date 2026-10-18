import { describe, expect, it, vi } from "vite-plus/test";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getComboByName: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
const { getModelInfo } = await import("../../src/sse/services/model.js");

function withKiro(customModels, providerSpecificData = { enabledModels: ["claude-sonnet-4.5"] }) {
  db.getProviderConnections.mockResolvedValue([{ id: 1, provider: "kiro", isActive: true, providerSpecificData }]);
  db.getCustomModels.mockResolvedValue(customModels);
  return buildModelsList(["llm"]);
}

describe("/v1/models custom models", () => {
  it("lists a custom model under the provider prefix, named by its id when it has no name", async () => {
    // Records written by addCustomModel default name to the id.
    const list = await withKiro([{ providerAlias: "kr", id: "claude-opus-4.6", type: "llm", name: "claude-opus-4.6" }]);
    const entry = list.find((m) => m.id === "kr/claude-opus-4.6");
    expect(entry).toMatchObject({ owned_by: "kr", name: "Kiro AI: claude-opus-4.6" });
  });

  it("uses the custom display name for the model part of `name`", async () => {
    const list = await withKiro([{ providerAlias: "kr", id: "claude-opus-4.6", type: "llm", name: "Claude Opus 4.6 (Kiro)" }]);
    expect(list.find((m) => m.id === "kr/claude-opus-4.6")?.name).toBe("Kiro AI: Claude Opus 4.6 (Kiro)");
  });

  it("still lists custom models when the live catalog is in use (no enabledModels)", async () => {
    const list = await withKiro([{ providerAlias: "kr", id: "my-custom", type: "llm" }], {});
    expect(list.some((m) => m.id === "kr/my-custom")).toBe(true);
  });

  it("does not list a custom model of another provider", async () => {
    const list = await withKiro([{ providerAlias: "cc", id: "only-on-claude", type: "llm" }]);
    expect(list.some((m) => m.id.endsWith("/only-on-claude"))).toBe(false);
  });
});

describe("custom model routing", () => {
  it.each(["kr/claude-opus-4.6", "kiro/claude-opus-4.6"])("%s resolves to kiro with the bare id", async (str) => {
    expect(await getModelInfo(str)).toEqual({ provider: "kiro", model: "claude-opus-4.6" });
  });

  it("keeps ids the registry has never heard of", async () => {
    expect(await getModelInfo("kr/some-future-model-9")).toEqual({ provider: "kiro", model: "some-future-model-9" });
  });
});
