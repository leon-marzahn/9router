import { describe, expect, it, vi } from "vitest";
import { validatePipelines } from "../../src/lib/request-pipelines/config.js";
import { transformRequest } from "../../src/lib/request-pipelines/engine.js";
import { runRequestPipeline } from "../../src/lib/request-pipelines/run.js";

const rule = { regex: "<internal_states>[\\s\\S]*?</internal_states>", replacement: "", depth: 1 };
const pipelines = [{ name: "agentic", rules: [rule] }];
const old = "<internal_states>old\nstate</internal_states>";
const latest = "<internal_states>new state</internal_states>";

describe("request pipelines", () => {
  it("keeps the latest match across messages and leaves the source intact", async () => {
    const body = { model: "test", messages: [{ role: "user", content: `a${old}` }, { role: "user", content: `b${old}c${latest}` }] };
    const result = await runRequestPipeline(body, "agentic", pipelines);
    expect(result.body.messages.map((message) => message.content)).toEqual(["a", `bc${latest}`]);
    expect(result.stats).toEqual([{ matches: 3, replaced: 2, preserved: 1 }]);
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
});
