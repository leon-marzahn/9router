// Smart Router (System One) as wired in this fork: the router model is an explicit
// per-combo choice (no free default that receives customer prompts), sticky
// conversations are scoped per API key, and the routing call is billed to the key.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  clearAccountError: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_p, c) => c),
  handleSystemoneCore: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  clearAccountError: mocks.clearAccountError,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: mocks.checkAndRefreshToken }));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.handleSystemoneCore }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { resolveSmartChoice, SMART_ROUTER_ENDPOINT } = await import("@/sse/services/systemoneRouter.js");
const { normalizeSmartConfig, scopeSessionToKey } = await import("../../open-sse/services/systemoneRouter.js");

const body = { messages: [{ role: "user", content: "write a sorting function in rust" }] };
const models = ["a/fast", "b/smart"];
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe("normalizeSmartConfig", () => {
  it("defaults to the adaptive policy at 80% with no router model", () => {
    expect(normalizeSmartConfig(undefined)).toEqual({ policy: "smart", threshold: 0.8, routerModel: null });
  });

  it("clamps the threshold and rejects unknown policies", () => {
    expect(normalizeSmartConfig({ smartPolicy: "yolo", confidenceThreshold: 5 }).threshold).toBe(0.99);
    expect(normalizeSmartConfig({ smartPolicy: "yolo", confidenceThreshold: 0 }).threshold).toBe(0.5);
    expect(normalizeSmartConfig({ smartPolicy: "yolo" }).policy).toBe("smart");
    expect(normalizeSmartConfig({ smartPolicy: "strict" }).policy).toBe("strict");
    expect(normalizeSmartConfig({ smartPolicy: "per-turn" }).policy).toBe("per-turn");
  });

  it("keeps a plain model id and drops anything else", () => {
    expect(normalizeSmartConfig({ routerModel: " ollama/clef-flash " }).routerModel).toBe("ollama/clef-flash");
    expect(normalizeSmartConfig({ routerModel: "http://169.254.169.254/x y" }).routerModel).toBeNull();
    expect(normalizeSmartConfig({ routerModel: "a\r\nb" }).routerModel).toBeNull();
    expect(normalizeSmartConfig({ routerModel: 42 }).routerModel).toBeNull();
  });
});

describe("scopeSessionToKey", () => {
  it("gives two API keys different sessions for the same conversation", () => {
    const a = scopeSessionToKey("conv-1", "sk-key-a");
    const b = scopeSessionToKey("conv-1", "sk-key-b");
    expect(a).not.toBe(b);
    expect(scopeSessionToKey("conv-1", "sk-key-a")).toBe(a);
  });

  it("never contains the raw key", () => {
    expect(scopeSessionToKey("conv-1", "sk-secret-123")).not.toContain("sk-secret-123");
  });

  it("has no session without a conversation key", () => {
    expect(scopeSessionToKey(null, "sk-a")).toBeNull();
  });
});

describe("resolveSmartChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModelInfo.mockResolvedValue({ provider: "ollama", model: "clef-flash" });
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn-1", apiKey: "upstream" });
    mocks.handleSystemoneCore.mockResolvedValue({
      success: true,
      usage: { prompt_tokens: 40, completion_tokens: 2 },
      response: Response.json({ answers: { route: { choice: "b/smart", confidence: 0.93 } } }),
    });
  });

  it("does nothing without a router model (no implicit default)", async () => {
    expect(await resolveSmartChoice({ body, models, routerModel: undefined, log })).toBeNull();
    expect(await resolveSmartChoice({ body, models, routerModel: "  ", log })).toBeNull();
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });

  it("returns the router's choice and bills the call to the calling key", async () => {
    const route = await resolveSmartChoice({
      body, models, routerModel: "ollama/clef-flash", log, apiKey: "sk-customer", comboName: "coding",
    });
    expect(route).toMatchObject({ choice: "b/smart", confidence: 0.93 });
    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "ollama",
      model: "clef-flash",
      requestedModel: "coding",
      apiKey: "sk-customer",
      endpoint: SMART_ROUTER_ENDPOINT,
      tokens: expect.objectContaining({ total_tokens: 42 }),
    }));
  });

  it("fails open when the router errors or times out", async () => {
    mocks.handleSystemoneCore.mockRejectedValueOnce(new Error("boom"));
    expect(await resolveSmartChoice({ body, models, routerModel: "ollama/clef-flash", log })).toBeNull();

    mocks.handleSystemoneCore.mockReturnValueOnce(new Promise(() => {}));
    expect(await resolveSmartChoice({ body, models, routerModel: "ollama/clef-flash", log, timeoutMs: 5 })).toBeNull();
    expect(mocks.saveRequestUsage).not.toHaveBeenCalled();
  });

  it("skips the call for a single-step combo or an empty prompt", async () => {
    expect(await resolveSmartChoice({ body, models: ["a/fast"], routerModel: "ollama/clef-flash", log })).toBeNull();
    expect(await resolveSmartChoice({ body: { messages: [] }, models, routerModel: "ollama/clef-flash", log })).toBeNull();
    expect(mocks.handleSystemoneCore).not.toHaveBeenCalled();
  });
});
