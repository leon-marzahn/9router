// /v1/api/chat end to end: real route, DB, translators and stream path; only the
// network is faked. An upstream that drops mid-stream must reach an Ollama client
// as an error line and a done line without done_reason (not a clean "stop").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: fetchMock, proxyAwareFetch: fetchMock }));
vi.mock("@/lib/notify/index.js", () => ({ notify: vi.fn(async () => ({ ok: true })) }));

const MODEL = "fake-model";
const PROVIDER = "openai-compatible-chat-ollamae2e";
let tempDir;
const originalDataDir = process.env.DATA_DIR;
let POST;
let clientKey;

/** SSE that sends one content chunk and then loses the connection. */
function droppingStream() {
  const enc = new TextEncoder();
  const chunk = { id: "c", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] };
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        setTimeout(() => controller.error(new Error("socket hang up")), 5);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-ollama-e2e-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const node = await db.createProviderNode({
    id: PROVIDER, type: "openai-compatible", name: "Fake drop", prefix: "drop", apiType: "chat", baseUrl: "http://drop.upstream.test/v1",
  });
  await db.createProviderConnection({
    provider: PROVIDER, authType: "apikey", name: "drop-key", apiKey: "sk-upstream-drop", isActive: true,
    providerSpecificData: { prefix: "drop", apiType: "chat", baseUrl: node.baseUrl, nodeName: node.name },
  });
  clientKey = (await db.createApiKey("ollama-e2e", "machine-fixture")).key;
  fetchMock.mockImplementation(async () => droppingStream());
  ({ POST } = await import("@/app/api/v1/api/chat/route.js"));
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Ollama /api/chat with an upstream that drops mid-stream", () => {
  it("sends the partial content, an error line, and one done line without done_reason", async () => {
    const res = await POST(new Request("http://localhost/v1/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${clientKey}` },
      body: JSON.stringify({ model: `drop/${MODEL}`, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(res.status).toBe(200);
    const out = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(out.filter((l) => !l.done && l.message).map((l) => l.message.content).join("")).toBe("Hel");
    expect(out.some((l) => typeof l.error === "string" && l.error.length > 0)).toBe(true);
    const done = out.filter((l) => l.done);
    expect(done).toHaveLength(1);
    expect(done[0].done_reason).toBeUndefined();
  });
});
