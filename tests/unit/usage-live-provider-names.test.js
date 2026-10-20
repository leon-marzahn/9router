// Regression: the Usage page's Live request list showed a custom node's internal
// id (`openai-compatible-chat-<uuid>`) instead of its name. The list's sources
// (stats recent/active requests, logged request details) now carry a
// `providerName` resolved like the inspector does (src/lib/providerName.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db, feedItemOf;
const NODE_ID = "openai-compatible-chat-11111111-2222-3333-4444-555555555555";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-live-names-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ feedItemOf } = await import("@/app/(dashboard)/dashboard/usage/live/useUsage"));
  await db.createProviderNode({ id: NODE_ID, type: "openai-compatible", name: "Office Llama", prefix: "llama", apiType: "chat", baseUrl: "http://127.0.0.1:1/v1" });
  for (const provider of [NODE_ID, "openai"]) {
    await db.saveRequestUsage({
      provider, model: "m", connectionId: "c1",
      tokens: { prompt_tokens: 3, completion_tokens: 4 }, status: "ok",
      timestamp: new Date().toISOString(),
    });
  }
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const nameOf = (list, provider) => list.find((r) => r.provider === provider)?.providerName;

describe("Live request list provider names", () => {
  it("stats recentRequests carry the node name (and registry names for built-ins)", async () => {
    const stats = await db.getUsageStats("24h");
    expect(nameOf(stats.recentRequests, NODE_ID)).toBe("Office Llama");
    expect(nameOf(stats.recentRequests, "openai")).toBe("OpenAI");
  });

  it("the live stream's recent/active lists carry the node name", async () => {
    db.trackPendingRequest("m", NODE_ID, "c1", true);
    const { recentRequests, activeRequests } = await db.getActiveRequests();
    db.trackPendingRequest("m", NODE_ID, "c1", false);
    expect(nameOf(recentRequests, NODE_ID)).toBe("Office Llama");
    expect(nameOf(activeRequests, NODE_ID)).toBe("Office Llama");
  });

  it("request details carry the node name, and the feed shows it", async () => {
    vi.doMock("@/lib/usageDb", () => ({
      getRequestDetails: async () => ({ details: [{ id: "rd-1", provider: NODE_ID, model: "m", request: { big: true } }], pagination: {} }),
    }));
    vi.resetModules();
    const { GET } = await import("../../src/app/api/usage/request-details/route.js");
    const res = await GET(new Request("http://localhost/api/usage/request-details?page=1&pageSize=10&summary=1"));
    const { details } = await res.json();
    expect(nameOf(details, NODE_ID)).toBe("Office Llama");
    expect(details[0].request).toBeUndefined(); // summary still drops bodies
    const item = feedItemOf({ id: "x", provider: NODE_ID, providerName: "Office Llama" });
    expect(item.providerName).toBe("Office Llama");
    expect(item.provider).toBe(NODE_ID);
  });
});
