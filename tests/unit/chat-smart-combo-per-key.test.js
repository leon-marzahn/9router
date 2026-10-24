// Smart combos through the real chat handler (handleChat -> comboSmartOptions ->
// handleComboChat): a conversation's sticky step is scoped to the API key, so two keys
// that send the same x-session-id never share a routing decision. chatCore and the
// System One call are mocked; nothing goes upstream.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ connectionId: "c1", connectionName: "c1", apiKey: "upstream" })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn((req) => req?.headers?.get("authorization")?.replace(/^Bearer /, "") || null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (m) => {
    const i = m.indexOf("/");
    return i < 0 ? { provider: null, model: m } : { provider: m.slice(0, i), model: m.slice(i + 1) };
  }),
  getComboModels: vi.fn(async (m) => (m === "smarty" ? ["openai/fast", "anthropic/deep"] : null)),
  stripComboPrefix: (m) => m,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => null),
  enforceKeyAccess: vi.fn(async () => null),
  filterAdapterModels: vi.fn(async (_ctx, models) => models),
  extractClientApiKey: vi.fn(() => null),
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: vi.fn(async () => null) }));
vi.mock("@/sse/services/budget.js", () => ({ enforceBudget: vi.fn(async () => null) }));
vi.mock("../../src/sse/services/stepReadiness.js", () => ({ isStepReady: vi.fn(async () => true) }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_p, c) => ({ ...c })),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => "p") }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("../../src/sse/services/systemoneRouter.js", () => ({ resolveSmartChoice: vi.fn() }));

import { getSettings } from "@/lib/localDb";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { resolveSmartChoice } from "../../src/sse/services/systemoneRouter.js";
import { resetComboRotation } from "open-sse/services/combo.js";
import { handleChat, comboSmartOptions } from "../../src/sse/handlers/chat.js";

const chat = (key, session) =>
  handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-session-id": session },
    body: JSON.stringify({ model: "smarty", messages: [{ role: "user", content: "refactor this module" }] }),
  }));
const servedModels = () => handleChatCore.mock.calls.map((c) => c[0].body.model);

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  getSettings.mockResolvedValue({
    comboStrategies: {
      smarty: { fallbackStrategy: "smart", smartPolicy: "strict", routerModel: "ollama/clef-flash" },
    },
  });
  handleChatCore.mockImplementation(async () => ({ success: true, response: Response.json({ ok: true }) }));
});

describe("smart combos through the chat handler", () => {
  it("keeps two keys' conversations apart even with the same x-session-id", async () => {
    // Key A's first turn: the router picks the deep model, which then sticks (Lock).
    resolveSmartChoice.mockResolvedValueOnce({ choice: "anthropic/deep", confidence: 0.95 });
    await chat("sk-key-a", "shared-session");
    // Key B, same session id: must get its own router call, not A's sticky pick.
    resolveSmartChoice.mockResolvedValueOnce({ choice: "openai/fast", confidence: 0.95 });
    await chat("sk-key-b", "shared-session");
    // Key A again: still locked to its own pick, no router call.
    await chat("sk-key-a", "shared-session");

    expect(resolveSmartChoice).toHaveBeenCalledTimes(2);
    expect(servedModels()).toEqual(["anthropic/deep", "openai/fast", "anthropic/deep"]);
    // The router call is billed to the key that triggered it.
    expect(resolveSmartChoice.mock.calls.map((c) => c[0].apiKey)).toEqual(["sk-key-a", "sk-key-b"]);
  });

  it("tries steps in order without a router model", async () => {
    getSettings.mockResolvedValue({ comboStrategies: { smarty: { fallbackStrategy: "smart" } } });
    await chat("sk-key-a", "s1");
    expect(resolveSmartChoice).not.toHaveBeenCalled();
    expect(servedModels()).toEqual(["openai/fast"]);
  });
});

describe("comboSmartOptions", () => {
  const request = new Request("http://localhost/", { headers: { "x-session-id": "same" } });
  it("scopes the session to the API key", () => {
    const a = comboSmartOptions({ routerModel: "ollama/clef" }, "smart", {}, request, "sk-a", "c");
    const b = comboSmartOptions({ routerModel: "ollama/clef" }, "smart", {}, request, "sk-b", "c");
    expect(a.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });
  it("adds nothing for other strategies", () => {
    expect(comboSmartOptions({}, "fallback", {}, request, "sk-a", "c")).toEqual({});
  });
});
