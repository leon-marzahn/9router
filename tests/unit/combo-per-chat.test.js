import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  STICKY_TTL_MS,
  orderForConversation,
  readyFirst,
  rememberStep,
  rememberedStep,
  resetComboAffinity,
} from "../../open-sse/services/comboAffinity.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { stripComboPrefix } from "../../src/sse/services/model.js";

const log = { info() {}, warn() {}, debug() {} };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });
const fail = () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
const STEPS = ["a/one", "b/two", "c/three", "d/four"];

/** Runs one request; `down` steps fail. Returns the step that answered. */
async function send(opts, down = new Set()) {
  let served = null;
  await handleComboChat({
    body: { messages: [] },
    models: STEPS,
    log,
    comboName: "c1",
    handleSingleModel: async (_b, m) => {
      if (down.has(m)) return fail();
      served = m;
      return ok();
    },
    ...opts,
  });
  return served;
}

describe("per-chat ordering", () => {
  it("is stable for one conversation and spreads conversations", () => {
    expect(orderForConversation(STEPS, "k1")).toEqual(orderForConversation(STEPS, "k1"));
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => orderForConversation(STEPS, `k${i}`)[0]));
    expect(firsts.size).toBeGreaterThan(2);
  });

  it("only moves conversations that were on a removed step", () => {
    for (let i = 0; i < 50; i++) {
      const before = orderForConversation(STEPS, `k${i}`)[0];
      const after = orderForConversation(STEPS.filter((s) => s !== "c/three"), `k${i}`)[0];
      if (before !== "c/three") expect(after).toBe(before);
    }
  });

  it("puts known-down steps last without dropping them", async () => {
    expect(await readyFirst(STEPS, (m) => m !== "a/one")).toEqual(["b/two", "c/three", "d/four", "a/one"]);
    expect(await readyFirst(STEPS, () => { throw new Error("x"); })).toEqual(STEPS);
  });
});

describe("handleComboChat stickiness", () => {
  beforeEach(() => resetComboAffinity());

  it("per-chat keeps a conversation on its step", async () => {
    const first = await send({ comboStrategy: "per-chat", affinityKey: "conv", stickAfterFallback: true });
    expect(first).toBe(orderForConversation(STEPS, "conv")[0]);
    expect(await send({ comboStrategy: "per-chat", affinityKey: "conv", stickAfterFallback: true })).toBe(first);
  });

  it("stays on the fallback step after its first choice recovers (stay mode)", async () => {
    const opts = { comboStrategy: "per-chat", affinityKey: "conv", stickAfterFallback: true };
    const [pref, second] = orderForConversation(STEPS, "conv");
    expect(await send(opts, new Set([pref]))).toBe(second);
    expect(await send(opts)).toBe(second); // pref is back, but the cache is on `second`
    expect(rememberedStep("c1", "conv")).toBe(second);
  });

  it("goes back to the first choice when stay is off", async () => {
    const opts = { comboStrategy: "per-chat", affinityKey: "conv", stickAfterFallback: false };
    const [pref] = orderForConversation(STEPS, "conv");
    await send(opts, new Set([pref]));
    expect(await send(opts)).toBe(pref);
  });

  it("in order: goes back up by default, stays when asked", async () => {
    expect(await send({ comboStrategy: "fallback", affinityKey: "conv" }, new Set(["a/one"]))).toBe("b/two");
    expect(await send({ comboStrategy: "fallback", affinityKey: "conv" })).toBe("a/one");

    const stay = { comboStrategy: "fallback", affinityKey: "conv2", stickAfterFallback: true };
    expect(await send(stay, new Set(["a/one"]))).toBe("b/two");
    expect(await send(stay)).toBe("b/two");
  });

  it("forgets after an hour idle", () => {
    rememberStep("c1", "k", "b/two", 0);
    expect(rememberedStep("c1", "k", STICKY_TTL_MS - 1)).toBe("b/two");
    expect(rememberedStep("c1", "k", STICKY_TTL_MS + 1)).toBeNull();
  });

  it("per-chat without a key behaves like take turns", async () => {
    const a = await send({ comboStrategy: "per-chat", comboName: "rr" });
    const b = await send({ comboStrategy: "per-chat", comboName: "rr" });
    expect(a).not.toBe(b);
  });
});

describe("combo/ prefix", () => {
  it("strips only a non-empty combo/ prefix", () => {
    expect(stripComboPrefix("combo/claude-best")).toBe("claude-best");
    expect(stripComboPrefix("combo/")).toBe("combo/");
    expect(stripComboPrefix("cc/opus")).toBe("cc/opus");
  });
});

describe("combo name shadow warning", () => {
  it("names the model a combo shadows, and nothing for made-up names", async () => {
    const { findShadowedModel } = await import("../../src/lib/comboNames.js");
    const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.js");
    const [provider, models] = Object.entries(PROVIDER_MODELS).find(([, m]) => m?.length);
    expect(findShadowedModel(models[0].id)).toMatch(/\//);
    expect(findShadowedModel("my-very-own-combo-xyz")).toBeNull();
    expect(provider).toBeTruthy();
  });
});
