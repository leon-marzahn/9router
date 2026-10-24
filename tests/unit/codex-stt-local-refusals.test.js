// Codex STT refusals the gateway makes itself (capacity, a down account proxy, bad
// audio) must never mark a Codex account unavailable: one API key could otherwise lock
// every account by filling the two conversion slots. One key also may not hold more than
// one slot, and successful transcriptions are billed to the calling key.
// Runs the real handler -> sttCore -> codexStt path; only audio conversion is held.
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  mark: vi.fn(async () => ({ shouldFallback: true })),
  clear: vi.fn(),
  proxy: vi.fn(),
  convert: vi.fn(),
  fetch: vi.fn(),
  usage: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: (req) => req.headers.get("authorization")?.replace(/^Bearer /, "") || null,
  isValidApiKey: vi.fn(async () => true),
  getProviderCredentials: mocks.get,
  clearAccountError: mocks.clear,
  markAccountUnavailable: mocks.mark,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), getCustomModels: async () => [] }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: async () => ({ provider: "codex", model: "transcribe" }) }));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => ({}), enforceKeyAccessResolved: async () => null }));
vi.mock("@/sse/services/budget.js", () => ({ enforceBudget: async () => null }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c }));
vi.mock("@/lib/network/connectionProxy.js", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.usage }));
// Real keys: sk-key-a/b/c and sk-customer. Anything else is a made-up bearer.
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (key) =>
    ["sk-key-a", "sk-key-b", "sk-key-c", "sk-customer"].includes(key)
      ? { id: `id-${key}`, key, isActive: true }
      : key === "sk-paused"
        ? { id: "id-paused", key, isActive: false }
        : null,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
vi.mock("open-sse/handlers/codexSttAudio.js", async (importOriginal) => ({
  ...(await importOriginal()),
  convertAudio: mocks.convert,
}));

const { handleStt, CODEX_STT_PER_KEY } = await import("@/sse/handlers/stt.js");

const account = (id) => ({
  authType: "oauth",
  accessToken: `token-${id}`,
  connectionId: id,
  connectionName: id,
  providerSpecificData: { workspaceId: `ws-${id}` },
});
function request(key) {
  const form = new FormData();
  form.set("model", "cx/transcribe");
  form.set("file", new File(["audio"], "a.wav"));
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
  });
}

// Conversions that hang until released, to hold the process-wide Codex slots.
let held = [];
const hold = () =>
  new Promise((resolve, reject) => {
    held.push({ resolve, reject });
  });

beforeEach(() => {
  vi.clearAllMocks();
  held = [];
  const accounts = [account("acct-1"), account("acct-2")];
  mocks.get.mockImplementation(async (_p, exclude) => accounts.find((a) => !exclude.has(a.connectionId)) || null);
  mocks.proxy.mockResolvedValue({ source: "none" });
  mocks.convert.mockImplementation(() => hold());
  mocks.fetch.mockResolvedValue(Response.json({ text: "hello" }));
});
afterEach(() => {
  for (const h of held) h.reject(Object.assign(new Error("released"), { status: 400 }));
});

it("returns capacity refusals to the client without marking any account", async () => {
  const a = handleStt(request("sk-key-a"));
  const b = handleStt(request("sk-key-b"));
  await vi.waitFor(() => expect(held).toHaveLength(2));

  const c = await handleStt(request("sk-key-c"));
  expect(c.status).toBe(503);
  expect(await c.text()).toContain("capacity");
  expect(mocks.mark).not.toHaveBeenCalled();
  // Only one account was tried: a local refusal doesn't walk the account list.
  expect(mocks.get).toHaveBeenCalledTimes(3);

  for (const h of held) h.reject(Object.assign(new Error("released"), { status: 400 }));
  held = [];
  await Promise.all([a, b]);
  expect(mocks.mark).not.toHaveBeenCalled();
});

it("limits one key to one Codex transcription at a time", async () => {
  expect(CODEX_STT_PER_KEY).toBe(1);
  const first = handleStt(request("sk-key-a"));
  await vi.waitFor(() => expect(held).toHaveLength(1));

  const second = await handleStt(request("sk-key-a"));
  expect(second.status).toBe(429);
  // Another key still gets the free slot.
  const other = handleStt(request("sk-key-b"));
  await vi.waitFor(() => expect(held).toHaveLength(2));

  for (const h of held) h.reject(Object.assign(new Error("released"), { status: 400 }));
  held = [];
  await Promise.all([first, other]);
  // The slot is free again afterwards.
  mocks.convert.mockResolvedValueOnce(new Blob(["wav"]));
  expect((await handleStt(request("sk-key-a"))).status).toBe(200);
});

it("puts made-up, paused and missing keys into one shared slot", async () => {
  const first = handleStt(request("sk-made-up-1"));
  await vi.waitFor(() => expect(held).toHaveLength(1));

  // A different invented bearer is not a new slot, nor is a paused key or no key at all.
  expect((await handleStt(request("sk-made-up-2"))).status).toBe(429);
  expect((await handleStt(request("sk-paused"))).status).toBe(429);
  expect((await handleStt(request(null))).status).toBe(429);
  // A real key still has its own slot.
  const real = handleStt(request("sk-key-a"));
  await vi.waitFor(() => expect(held).toHaveLength(2));

  for (const h of held) h.reject(Object.assign(new Error("released"), { status: 400 }));
  held = [];
  await Promise.all([first, real]);
});

it("skips an account whose proxy is down without marking it", async () => {
  mocks.proxy.mockResolvedValueOnce({ source: "error" }).mockResolvedValue({ source: "none" });
  mocks.convert.mockResolvedValue(new Blob(["wav"]));
  const res = await handleStt(request("sk-key-a"));
  expect(res.status).toBe(200);
  expect(mocks.mark).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("still marks an account when the upstream rejects it", async () => {
  mocks.convert.mockResolvedValue(new Blob(["wav"]));
  mocks.fetch.mockResolvedValue(new Response("nope", { status: 429 }));
  await handleStt(request("sk-key-a"));
  expect(mocks.mark).toHaveBeenCalledWith("acct-1", 429, expect.any(String), "codex", "transcribe");
});

it("records a usage row against the calling key", async () => {
  mocks.convert.mockResolvedValue(new Blob(["wav"]));
  expect((await handleStt(request("sk-customer"))).status).toBe(200);
  expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({
    provider: "codex",
    model: "transcribe",
    apiKey: "sk-customer",
    connectionId: "acct-1",
    endpoint: "/v1/audio/transcriptions",
    status: "success",
  }));
});
