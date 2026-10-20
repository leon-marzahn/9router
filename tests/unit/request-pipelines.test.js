import { describe, expect, it, vi } from "vite-plus/test";
import { selectPipelines, validatePipelines } from "../../src/lib/request-pipelines/config.js";
import { transformRequest } from "../../src/lib/request-pipelines/engine.js";
import { getPipelineStats, runPipelines, runRequestPipeline } from "../../src/lib/request-pipelines/run.js";

const rule = { regex: "<internal_states>[\\s\\S]*?</internal_states>", replacement: "", depth: 1 };
const pipelines = [{ name: "agentic", rules: [rule] }];
const old = "<internal_states>old\nstate</internal_states>";
const latest = "<internal_states>new state</internal_states>";

describe("request pipelines", () => {
  it("keeps the latest match across messages and leaves the source intact", async () => {
    const body = { model: "test", messages: [{ role: "user", content: `a${old}` }, { role: "user", content: `b${old}c${latest}` }] };
    const result = await runRequestPipeline(body, "agentic", pipelines);
    expect(result.body.messages.map((message) => message.content)).toEqual(["a", `bc${latest}`]);
    expect(result.stats).toEqual([{ matches: 3, replaced: 2, preserved: 1, removed: 2 * old.length }]);
    expect(body.messages[0].content).toBe(`a${old}`);
  });

  it("does no work without a selector, and rejects unknown or empty names", async () => {
    const body = { messages: [{ content: old }] };
    expect((await runRequestPipeline(body, null, pipelines)).body).toBe(body);
    await expect(runRequestPipeline(body, "missing", pipelines)).rejects.toThrow("Unknown request pipeline");
    await expect(runRequestPipeline(body, "", pipelines)).rejects.toThrow("Unknown request pipeline");
  });

  it("runs rules in order with capture replacements and depth zero", () => {
    const result = transformRequest({ input: "STATE:old STATE:new" }, [
      { regex: "/state:(\\w+)/i", replacement: "<$1>", depth: 0 },
      { regex: "<\\w+>", replacement: "", depth: 1 },
    ]);
    expect(result.body.input).toBe(" <new>");
  });

  it("handles system blocks, Responses input, and textual tool results without changing tool arguments or images", () => {
    const body = {
      instructions: old,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: old }, { type: "input_image", image_url: old }] },
        { type: "function_call", arguments: old },
        { type: "function_call_output", call_id: "keep", output: old },
        { type: "message", role: "user", content: latest },
      ],
      tools: [{ description: old }],
      metadata: { text: old },
    };
    const { body: result } = transformRequest(body, [rule]);
    expect(result.instructions).toBe("");
    expect(result.input[0].content[0].text).toBe("");
    expect(result.input[0].content[1].image_url).toBe(old);
    expect(result.input[1].arguments).toBe(old);
    expect(result.input[2]).toEqual({ type: "function_call_output", call_id: "keep", output: "" });
    expect(result.input[3].content).toBe(latest);
    expect(result.tools).toEqual(body.tools);
    expect(result.metadata).toEqual(body.metadata);
  });

  it("handles Claude nested tool results and Gemini parts", () => {
    const claude = { system: [{ type: "text", text: old }], messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "id", content: [{ type: "text", text: old }] },
      { type: "text", text: latest },
    ] }] };
    const result = transformRequest(claude, [rule]).body;
    expect(result.system[0].text).toBe("");
    expect(result.messages[0].content[0].content[0].text).toBe("");
    expect(result.messages[0].content[1].text).toBe(latest);
    const gemini = transformRequest({ systemInstruction: { parts: [{ text: old }] }, contents: [{ parts: [{ text: latest }] }] }, [rule]).body;
    expect(gemini.systemInstruction.parts[0].text).toBe("");
    expect(gemini.contents[0].parts[0].text).toBe(latest);
  });

  it("preserves all matches when depth exceeds the count and terminates zero-width matching", () => {
    expect(transformRequest({ input: old }, [{ ...rule, depth: 10 }]).body.input).toBe(old);
    expect(transformRequest({ input: "ab" }, [{ regex: "(?=.)", replacement: "-", depth: 1 }]).body.input).toBe("-ab");
  });

  it("matches native JavaScript capture replacement semantics", () => {
    const regex = /(?<letter>a)(b)?/g;
    const replacement = "$$ $& $` $' $1 $2 $12 $01 $99 $<letter> $<missing>";
    const input = "ac ab";
    expect(transformRequest({ input }, [{ regex: regex.toString(), replacement, depth: 0 }]).body.input).toBe(input.replace(regex, replacement));
  });

  it("validates rules and supplies defaults", () => {
    expect(validatePipelines([{ name: "test", rules: [{ regex: "a" }] }])[0].rules[0]).toEqual({ regex: "a", replacement: "", depth: 0 });
    for (const patch of [{ regex: "[" }, { regex: "/a/gg" }, { depth: -1 }, { depth: 0.5 }, { depth: "1" }, { replacement: 2 }]) {
      expect(() => validatePipelines([{ name: "test", rules: [{ ...rule, ...patch }] }])).toThrow();
    }
    expect(() => validatePipelines([...pipelines, ...pipelines])).toThrow("Duplicate");
    expect(() => validatePipelines([{ name: "bad name", rules: [rule] }])).toThrow();
  });

  it("compiles step kinds from their parameters, ignoring a sent regex", () => {
    const [p] = validatePipelines([{ name: "rp", rules: [
      { kind: "tag", tag: "internal_states", unclosed: true, depth: 1, regex: "anything" },
      { kind: "markers", start: "<!-- GFX_START -->", end: "<!-- GFX_END -->", unclosed: true },
      { kind: "details", title: "Scene Plan" },
      { kind: "redact", replacement: "kept?", depth: 3 },
    ] }]);
    const text = [
      "a <internal_states>old</internal_states>",
      "<!--GFX_START-->x<!--  GFX_END -->b",
      "<details><summary>📋 Scene Plan</summary>p<details><summary>n</summary>m</details>q</details>c",
      "<details><summary>Other</summary>keep</details>",
      "key sk-ant-abcdefghijklmnop1234 <internal_states>open, never closed",
    ].join("|");
    const out = transformRequest({ input: text }, p.rules).body.input;
    expect(out).toBe("a |b|c|<details><summary>Other</summary>keep</details>|key [redacted] <internal_states>open, never closed");
    expect(p.rules[3]).toMatchObject({ kind: "redact", replacement: "[redacted]", depth: 0 });
    expect(p.rules[0].regex).not.toBe("anything");
  });

  it("escapes step parameters and rejects unsafe tag names", () => {
    const [p] = validatePipelines([{ name: "x", rules: [{ kind: "details", title: "a.b (c)" }] }]);
    expect(transformRequest({ input: "<details><summary>axb (c)</summary>z</details>" }, p.rules).body.input).not.toBe("");
    for (const rule of [{ kind: "tag", tag: "a>b" }, { kind: "tag" }, { kind: "markers", start: "x" }, { kind: "eval" }]) {
      expect(() => validatePipelines([{ name: "x", rules: [rule] }])).toThrow();
    }
  });

  it("skips disabled rules and keeps stats aligned with rules", async () => {
    const result = await runPipelines({ input: "ab" }, [{ name: "p", rules: [{ regex: "a", enabled: false }, { regex: "b" }] }]);
    expect(result.body.input).toBe("a");
    expect(result.stats[0]).toBeNull();
    expect(result.stats[1]).toMatchObject({ replaced: 1 });
  });

  it("selects attached pipelines before the header one, once each, and the header cannot remove them", () => {
    const list = validatePipelines([
      { name: "key", rules: [rule], attach: { keys: ["k1"] } },
      { name: "combo", rules: [rule], attach: { combos: ["Fast"] } },
      { name: "agentic", rules: [rule] },
    ]);
    const names = (ctx) => selectPipelines(list, ctx).map((p) => p.name);
    expect(names({ keyId: "k1", combo: "fast", header: "agentic" })).toEqual(["key", "combo", "agentic"]);
    expect(names({ keyId: "k1", header: "key" })).toEqual(["key"]);
    expect(names({ keyId: "k2", combo: "slow" })).toEqual([]);
    expect(() => selectPipelines(list, { keyId: "k1", header: "missing" })).toThrow("Unknown request pipeline");
  });

  it("counts tracked runs only", async () => {
    const p = [{ name: "counted", rules: [{ regex: "a" }] }];
    await runPipelines({ input: "aaa" }, p);
    expect(getPipelineStats().counted).toBeUndefined();
    await runPipelines({ input: "aaa" }, p, { track: true });
    expect(getPipelineStats().counted).toMatchObject({ requests: 1, charsRemoved: 3 });
  });

  it("terminates pathological regex execution", async () => {
    await expect(runRequestPipeline({ input: "a".repeat(100000) + "!" }, "slow", [
      { name: "slow", rules: [{ regex: "(a+)+$", replacement: "", depth: 0 }] },
    ], 100)).rejects.toThrow("time limit");
  });
});

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(), updateSettings: vi.fn(async (body) => body) }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

describe("pipeline settings API", () => {
  it("rejects malformed settings before persistence and saves valid pipelines", async () => {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const { updateSettings } = await import("@/lib/localDb");
    updateSettings.mockClear();
    const request = (requestPipelines) => new Request("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify({ requestPipelines }) });
    const invalid = await PATCH(request([{ name: "broken", rules: [{ regex: "[" }] }]));
    expect(invalid.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
    const valid = await PATCH(request(pipelines));
    expect(valid.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ requestPipelines: pipelines });
  });

  it("previews unsaved rules with the request engine", async () => {
    const { POST } = await import("../../src/app/api/settings/request-pipelines/preview/route.js");
    const response = await POST(new Request("http://localhost/api/settings/request-pipelines/preview", {
      method: "POST", body: JSON.stringify({ pipeline: pipelines[0], body: { input: old + latest } }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).body.input).toBe(latest);
  });

  it("previews a pipeline whose newly added step is still blank, skipping that step", async () => {
    const { POST } = await import("../../src/app/api/settings/request-pipelines/preview/route.js");
    const call = (pipeline) => POST(new Request("http://localhost/api/settings/request-pipelines/preview", {
      method: "POST", body: JSON.stringify({ pipeline, body: { input: old + latest } }),
    }));
    const withBlank = { ...pipelines[0], rules: [...pipelines[0].rules, { regex: "", replacement: "" }, { kind: "tag", tag: " " }] };
    const response = await call(withBlank);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.body.input).toBe(latest);
    expect(data.stats).toHaveLength(withBlank.rules.length);
    expect(data.stats.slice(-2)).toEqual([null, null]);
    expect(data.stats[0]).not.toBeNull();
    const onlyBlank = await call({ name: "draft", rules: [{ regex: "" }] });
    expect(onlyBlank.status).toBe(200);
    expect(await onlyBlank.json()).toEqual({ body: { input: old + latest }, stats: [null] });
    // A malformed (not blank) step is still an error.
    expect((await call({ name: "draft", rules: [{ regex: "(" }] })).status).toBe(400);
  });
});
