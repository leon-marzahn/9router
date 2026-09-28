import { beforeEach, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ connectionId: "test" })),
  markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => "test"), isValidApiKey: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "test" })),
  getComboModels: vi.fn(async () => null),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(), checkAndRefreshToken: vi.fn(async (_, credentials) => credentials),
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(), clearAntigravityStrikes: vi.fn() }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn() }));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: (models) => models,
  withCapacityAdapterStripping: (fn) => fn,
  getActiveAdapterStrategy: () => "fallback",
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(async ({ body, models, handleSingleModel }) => handleSingleModel(body, models[0])),
  handleFusionChat: vi.fn(), detectRequiredCapabilities: () => new Set(),
}));

import { getSettings } from "@/lib/localDb";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { getComboModels } from "../../src/sse/services/model.js";
import { isValidApiKey } from "../../src/sse/services/auth.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const request = (selector = "agentic") => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: selector === null ? {} : { "X-9Router-Pipeline": selector },
  body: JSON.stringify({ model: "openai/test", messages: [{ role: "user", content: "aaa" }] }),
});

beforeEach(() => {
  vi.clearAllMocks();
  getComboModels.mockResolvedValue(null);
  isValidApiKey.mockResolvedValue(true);
  getSettings.mockResolvedValue({ requireApiKey: true, requestPipelines: [{ name: "agentic", rules: [{ regex: "a", replacement: "aa", depth: 1 }] }] });
  handleChatCore.mockImplementation(async () => ({ success: true, response: Response.json({ ok: true }) }));
});

it("processes before provider execution, retaining original logs and stripping the selector", async () => {
  expect((await handleChat(request())).status).toBe(200);
  const sent = handleChatCore.mock.calls[0][0];
  expect(sent.body.messages[0].content).toBe("aaaaa");
  expect(sent.clientRawRequest.body.messages[0].content).toBe("aaa");
  expect(sent.clientRawRequest.headers).not.toHaveProperty("x-9router-pipeline");
});

it("does not reapply processing during combo routing", async () => {
  getComboModels.mockResolvedValue(["openai/test"]);
  await handleChat(request());
  expect(handleChatCore.mock.calls[0][0].body.messages[0].content).toBe("aaaaa");
});

it("leaves unselected requests unchanged", async () => {
  await handleChat(request(null));
  expect(handleChatCore.mock.calls[0][0].body.messages[0].content).toBe("aaa");
});

it("rejects unknown selectors without sending upstream", async () => {
  expect((await handleChat(request("missing"))).status).toBe(400);
  expect(handleChatCore).not.toHaveBeenCalled();
});

it("authenticates before resolving the pipeline", async () => {
  isValidApiKey.mockResolvedValue(false);
  expect((await handleChat(request("missing"))).status).toBe(401);
  expect(handleChatCore).not.toHaveBeenCalled();
});
