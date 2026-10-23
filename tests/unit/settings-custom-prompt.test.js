// The RTK custom system prompt (8a842043) is injected into every chat request, so the
// settings route only accepts a bounded string and a boolean switch.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = { current: {} };
const updateSettings = vi.fn(async (patch) => (store.current = { ...store.current, ...patch }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => store.current, updateSettings }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: () => {} }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: () => {} }));
vi.mock("@/lib/request-pipelines/config.js", () => ({ validatePipelines: (p) => p }));

const { PATCH } = await import("../../src/app/api/settings/route.js");
const patch = (body) => PATCH(new Request("http://x/api/settings", { method: "PATCH", body: JSON.stringify(body) }));

describe("settings PATCH custom prompt", () => {
  beforeEach(() => {
    updateSettings.mockClear();
    store.current = {};
  });

  it("stores a prompt and the switch", async () => {
    const res = await patch({ customPromptEnabled: true, customPrompt: "Answer in British English." });
    expect(res.status).toBe(200);
    expect(store.current).toMatchObject({ customPromptEnabled: true, customPrompt: "Answer in British English." });
  });

  it("refuses a prompt over 8000 characters", async () => {
    expect((await patch({ customPrompt: "x".repeat(8001) })).status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("refuses non-string prompts and non-boolean switches", async () => {
    expect((await patch({ customPrompt: { role: "system" } })).status).toBe(400);
    expect((await patch({ customPromptEnabled: "yes" })).status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
