// Paths the 0.5.109 sync changed that other suites don't reach:
// - Antigravity image requests keep inline reference images (161e3493) and drop the rest.
// - Executor-backed image errors keep the upstream status and quota reset time.
// - Smart combos fail open when the router throws, with or without a sticky pick.
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { resetStickyComboStore } from "../../open-sse/services/systemoneRouter.js";

const executeViaExecutor = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/handlers/imageProviders/index.js", () => ({
  getImageAdapter: () => ({
    useExecutor: true,
    executeViaExecutor,
    normalize: (b) => b,
  }),
}));
const { handleImageGenerationCore } = await import("../../open-sse/handlers/imageGenerationCore.js");

afterEach(() => resetStickyComboStore());

describe("antigravity image request", () => {
  it("keeps text and inline reference images, drops other parts and empty turns", () => {
    const out = new AntigravityExecutor().transformRequest("gemini-3.1-flash-image-16x9", {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }, { text: "make it blue" }] },
        { parts: [{ fileData: { fileUri: "gs://x" } }, { inlineData: { mimeType: "image/png" } }] },
      ],
    }, false, {});
    const contents = out.request.contents;
    expect(contents).toHaveLength(1);
    expect(contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAA" } },
      { text: "make it blue" },
    ]);
  });
});

describe("executor-backed image errors", () => {
  it("keep the upstream status and reset time", async () => {
    executeViaExecutor.mockRejectedValueOnce(Object.assign(new Error("quota"), { status: 429, resetsAtMs: 123 }));
    const res = await handleImageGenerationCore({
      body: { prompt: "p" },
      modelInfo: { provider: "antigravity", model: "gemini-3.1-flash-image" },
      credentials: {},
    });
    expect(res.success).toBe(false);
    expect(res.status).toBe(429);
    expect(res.resetsAtMs).toBe(123);
  });

  it("default to 502 when the error has no status", async () => {
    executeViaExecutor.mockRejectedValueOnce(new Error("boom"));
    const res = await handleImageGenerationCore({
      body: { prompt: "p" },
      modelInfo: { provider: "antigravity", model: "gemini-3.1-flash-image" },
      credentials: {},
    });
    expect(res.status).toBe(502);
  });
});

describe("smart combo fails open", () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const models = ["a/one", "b/two"];
  const ok = (m) => Response.json({ choices: [{ message: { content: m } }] });
  const run = (resolveSmartChoice, extra = {}) => {
    const handleSingleModel = vi.fn(async (_b, m) => ok(m));
    return handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel,
      log,
      comboName: "smart-c",
      comboStrategy: "smart",
      sessionId: "s1",
      resolveSmartChoice,
      ...extra,
    }).then(() => handleSingleModel.mock.calls.map((c) => c[1]));
  };

  it("tries steps in order when the first router call throws", async () => {
    expect(await run(async () => { throw new Error("router down"); })).toEqual(["a/one"]);
  });

  it("keeps the sticky pick when a later router call throws, or when there is no router", async () => {
    expect(await run(async () => ({ choice: "b/two", confidence: 0.99 }))).toEqual(["b/two"]);
    expect(await run(async () => { throw new Error("router down"); })).toEqual(["b/two"]);
    expect(await run(null)).toEqual(["b/two"]);
  });
});
