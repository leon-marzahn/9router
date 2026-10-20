// Regression: with requireApiKey on, /v1beta (Gemini) requests that carry the key
// only in `x-goog-api-key` (the Gemini SDK header) or `?key=` were rejected by
// handleChat with 401 "Missing API key", while Bearer worked. The key must now be
// read the same way everywhere and get exactly the same checks as Bearer:
// validity, per-key access and the per-key budget, plus usage attribution.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const fx = vi.hoisted(() => ({ keys: {}, overBudget: new Set() }));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: true, comboStrategy: "fallback" }),
  validateApiKey: mocks.validateApiKey,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/lib/budgets/index.js", () => ({
  checkBudget: async (key) => (fx.overBudget.has(key) ? { global: false, resetsAt: new Date(Date.now() + 60_000).toISOString() } : null),
}));
vi.mock("@/sse/services/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const geminiRoute = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { extractApiKey } = await import("../../src/sse/services/auth.js");

const GOOD = "sk-good-0123456789";
const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

function gemini(headers = {}, query = "") {
  return geminiRoute.POST(
    new Request(`http://localhost/v1beta/models/openai/model-a:generateContent${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: ["openai", "model-a:generateContent"] }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fx.keys = {
    [GOOD]: { id: "g", name: "good", isActive: true, access: { restricted: false, allow: [] } },
    "sk-only-b": { id: "b", name: "only-b", isActive: true, access: { restricted: true, allow: ["openai/model-b"] } },
    "sk-broke": { id: "x", name: "broke", isActive: true, access: { restricted: false, allow: [] } },
  };
  fx.overBudget = new Set(["sk-broke"]);
  mocks.validateApiKey.mockImplementation(async (k) => Boolean(fx.keys[k]));
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  mocks.handleChatCore.mockResolvedValue({
    success: true,
    response: Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
  });
});

describe("extractApiKey", () => {
  const r = (headers, url = "http://localhost/v1/chat/completions") => new Request(url, { headers });
  it("reads Bearer, x-api-key, x-goog-api-key, then ?key=, in that order", () => {
    expect(extractApiKey(r({ Authorization: "Bearer a", "x-api-key": "b", "x-goog-api-key": "c" }, "http://l/x?key=d"))).toBe("a");
    expect(extractApiKey(r({ "x-api-key": "b", "x-goog-api-key": "c" }, "http://l/x?key=d"))).toBe("b");
    expect(extractApiKey(r({ "x-goog-api-key": "c" }, "http://l/x?key=d"))).toBe("c");
    expect(extractApiKey(r({}, "http://l/x?key=d"))).toBe("d");
    expect(extractApiKey(r({}))).toBeNull();
  });
  it("returns null for a request without headers or with an unparseable URL", () => {
    expect(extractApiKey(null)).toBeNull();
    expect(extractApiKey({ headers: new Headers(), url: "not a url" })).toBeNull();
  });
});

describe("/v1beta generateContent with requireApiKey", () => {
  it("accepts a valid key in x-goog-api-key and attributes usage to it", async () => {
    const res = await gemini({ "x-goog-api-key": GOOD });
    expect(res.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].apiKey).toBe(GOOD);
  });

  it("accepts a valid key in ?key= and keeps it out of the logged endpoint", async () => {
    const res = await gemini({}, `?key=${GOOD}`);
    expect(res.status).toBe(200);
    const { apiKey, clientRawRequest } = mocks.handleChatCore.mock.calls[0][0];
    expect(apiKey).toBe(GOOD);
    expect(clientRawRequest.endpoint).not.toContain(GOOD);
  });

  it("rejects a wrong x-goog-api-key or ?key= with 401 Invalid API key", async () => {
    for (const res of [await gemini({ "x-goog-api-key": "sk-wrong" }), await gemini({}, "?key=sk-wrong")]) {
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).toMatch(/Invalid API key/);
    }
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("still rejects a request with no key at all", async () => {
    const res = await gemini();
    expect(res.status).toBe(401);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("applies per-key access restrictions to x-goog-api-key", async () => {
    const res = await gemini({ "x-goog-api-key": "sk-only-b" });
    expect(res.status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("applies the per-key budget hard stop to x-goog-api-key and ?key=", async () => {
    for (const res of [await gemini({ "x-goog-api-key": "sk-broke" }), await gemini({}, "?key=sk-broke")]) {
      expect(res.status).toBe(429);
    }
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});
