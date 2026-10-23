// 161e3493 / 38a0c449: Gemini and Antigravity image generation take reference images as
// inline base64 / data URIs. URLs are never fetched server-side (no SSRF surface).
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute }),
}));

const antigravity = (await import("../../open-sse/handlers/imageProviders/antigravity.js")).default;
const gemini = (await import("../../open-sse/handlers/imageProviders/gemini.js")).default;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
const RAW = "A".repeat(120);
const okResponse = (parts = [{ inlineData: { data: "b64-out" } }]) => ({
  response: new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 }),
});

describe("antigravity image adapter", () => {
  beforeEach(() => execute.mockReset());

  it("sends reference images first (object and string forms), then the prompt", async () => {
    execute.mockResolvedValue(okResponse());
    await antigravity.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "a cat",
      reference_images: [PNG, { image_url: { url: PNG } }, { b64_json: RAW }],
    });
    const { body, model } = execute.mock.calls[0][0];
    const parts = body.contents[0].parts;
    expect(parts.slice(0, 3).every((p) => p.inlineData)).toBe(true);
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[2].inlineData).toEqual({ mimeType: "image/png", data: RAW });
    expect(parts.at(-1)).toEqual({ text: "a cat" });
    expect(model).toBe("gemini-3.1-flash-image");
  });

  it("never turns a URL into an image part, and caps references at 10", async () => {
    execute.mockResolvedValue(okResponse());
    await antigravity.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "x",
      images: ["http://169.254.169.254/latest/meta-data", ...Array(12).fill(PNG)],
    });
    const parts = execute.mock.calls[0][0].body.contents[0].parts;
    expect(parts.filter((p) => p.inlineData)).toHaveLength(9); // 10 kept, the URL dropped
    expect(JSON.stringify(parts)).not.toContain("169.254");
  });

  it("uses aspect_ratio over size, folds the negative prompt in and picks an image model", async () => {
    execute.mockResolvedValue(okResponse());
    await antigravity.executeViaExecutor("gemini-chat", {
      prompt: "p",
      aspect_ratio: "16:9",
      size: "1024x1024",
      negative_prompt: "blurry",
    });
    const { body, model } = execute.mock.calls[0][0];
    expect(model).toBe("gemini-3.1-flash-image-16x9");
    expect(body.contents[0].parts.at(-1).text).toBe("p\n\nNegative prompt: blurry");
  });

  it("surfaces upstream errors with the quota reset time", async () => {
    const reset = new Date(Date.now() + 60_000).toISOString();
    execute.mockResolvedValue({
      response: new Response(
        JSON.stringify({ error: { details: [{ metadata: { quotaResetTimeStamp: reset } }] } }),
        { status: 429 },
      ),
    });
    const err = await antigravity.executeViaExecutor("gemini-3.1-flash-image", { prompt: "p" }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.resetsAtMs).toBe(new Date(reset).getTime());
  });

  it("normalizes inline image parts", () => {
    const out = antigravity.normalize({ candidates: [{ content: { parts: [{ inlineData: { data: "abc" } }] } }] }, "p");
    expect(out.data).toEqual([{ b64_json: "abc" }]);
  });
});

describe("gemini image adapter", () => {
  it("puts a data-URI or base64 reference image before the prompt", () => {
    const body = gemini.buildBody("m", { prompt: "edit", image: PNG });
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
    expect(body.contents[0].parts[1]).toEqual({ text: "edit" });
    const raw = gemini.buildBody("m", { prompt: "edit", images: [RAW] });
    expect(raw.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/png", data: RAW });
  });

  it("ignores URLs", () => {
    const body = gemini.buildBody("m", { prompt: "edit", image: "https://example.com/a.png" });
    expect(body.contents[0].parts).toEqual([{ text: "edit" }]);
  });
});
