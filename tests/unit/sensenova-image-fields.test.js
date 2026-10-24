// SenseNova's image endpoint only receives imageConfig.bodyFields (the OpenAI image
// adapter whitelists them), so a model may only declare params / capabilities that
// actually reach the upstream; the Try-it example shows exactly the declared params.
import { describe, it, expect } from "vite-plus/test";
import sensenova from "../../open-sse/providers/registry/sensenova.js";
import createOpenAIAdapter from "../../open-sse/handlers/imageProviders/openai.js";

const imageModels = sensenova.models.filter((m) => m.kind === "image");
const sent = new Set(sensenova.imageConfig.bodyFields);

describe("SenseNova image models", () => {
  it("declare only params that are forwarded", () => {
    for (const m of imageModels) {
      for (const p of m.params) expect(sent.has(p), `${m.id} declares ${p}`).toBe(true);
    }
  });

  it("don't claim edit, since no source image is forwarded", () => {
    expect(sent.has("image")).toBe(false);
    for (const m of imageModels) expect(m.capabilities).not.toContain("edit");
  });

  it("forward watermark and prompt_extend but drop undeclared options", () => {
    const body = createOpenAIAdapter("sensenova").buildBody("sensenova-u1.5-lite", {
      prompt: "a cat",
      watermark: false,
      prompt_extend: true,
      quality: "hd",
      image: "data:image/png;base64,AAAA",
    });
    expect(body).toMatchObject({ watermark: false, prompt_extend: true });
    expect(body).not.toHaveProperty("quality");
    expect(body).not.toHaveProperty("image");
  });
});
