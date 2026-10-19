// Responses API -> chat pivot: call_id pairing, argument/output coercion, grouping.
import { describe, it, expect } from "vite-plus/test";
import {
  normalizeResponsesInput, clampResponsesCallId, coerceResponsesArguments, coerceResponsesOutput,
  convertResponsesApiFormat, MAX_RESPONSES_CALL_ID_LEN,
} from "../../open-sse/translator/formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../../open-sse/translator/schema/index.js";

describe("responsesApi helpers", () => {
  it("normalizeResponsesInput handles strings, empty arrays and garbage", () => {
    expect(normalizeResponsesInput("  ")[0].content[0].text).toBe("...");
    expect(normalizeResponsesInput("hi")[0]).toMatchObject({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER });
    expect(normalizeResponsesInput([])[0].content[0].text).toBe("...");
    const arr = [{ a: 1 }];
    expect(normalizeResponsesInput(arr)).toBe(arr);
    expect(normalizeResponsesInput(5)).toBeNull();
  });

  it("clampResponsesCallId truncates long ids and generates unique fallbacks", () => {
    expect(clampResponsesCallId("x".repeat(100))).toHaveLength(MAX_RESPONSES_CALL_ID_LEN);
    expect(clampResponsesCallId("short")).toBe("short");
    const a = clampResponsesCallId("");
    const b = clampResponsesCallId(null);
    expect(a).toMatch(/^call_/);
    expect(a).not.toBe(b);
  });

  it("coerceResponsesArguments single-stringifies and rejects fragments", () => {
    expect(coerceResponsesArguments(undefined)).toBe("{}");
    expect(coerceResponsesArguments("")).toBe("{}");
    expect(coerceResponsesArguments({ a: 1 })).toBe("{\"a\":1}");
    expect(coerceResponsesArguments("{\"a\":1}")).toBe("{\"a\":1}");
    expect(coerceResponsesArguments("{\"a\"")).toBe("{}");
    const cyc = {};
    cyc.self = cyc;
    expect(coerceResponsesArguments(cyc)).toBe("{}");
  });

  it("coerceResponsesOutput always returns a string", () => {
    expect(coerceResponsesOutput("s")).toBe("s");
    expect(coerceResponsesOutput(null)).toBe("");
    expect(coerceResponsesOutput([{ text: "a" }, { b: 1 }])).toBe("a{\"b\":1}");
    expect(coerceResponsesOutput({ x: 1 })).toBe("{\"x\":1}");
    const cyc = {};
    cyc.self = cyc;
    expect(coerceResponsesOutput(cyc)).toBe("[object Object]");
    expect(coerceResponsesOutput([1n])).toBe("1");
  });
});

describe("convertResponsesApiFormat", () => {
  it("returns body unchanged without input or with invalid input", () => {
    const b = { messages: [] };
    expect(convertResponsesApiFormat(b)).toBe(b);
    const c = { input: 42 };
    expect(convertResponsesApiFormat(c)).toBe(c);
  });

  it("round-trips function_call / function_call_output with matching ids and strips Responses fields", () => {
    const out = convertResponsesApiFormat({
      model: "m", instructions: "sys", store: true, include: [], prompt_cache_key: "k", reasoning: {},
      input: [
        { role: ROLE.USER, content: [
          { type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" },
          { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: "https://x/y.png" },
          { type: RESPONSES_ITEM.INPUT_IMAGE, file_id: "f1", detail: "high" },
          { type: "other", z: 1 },
        ] },
        { type: RESPONSES_ITEM.REASONING, summary: [] },
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "c1", name: "a", arguments: "{}" },
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "c0", name: " ", arguments: "{}" },
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "c2", name: "b", arguments: "{}" },
        { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: "c1", output: "r1" },
        { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: "c2", output: { ok: true } },
        { type: RESPONSES_ITEM.MESSAGE, role: ROLE.ASSISTANT, content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: "done" }] },
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "c3", name: "c", arguments: "{}" },
      ],
    });
    for (const k of ["input", "instructions", "include", "prompt_cache_key", "store", "reasoning"]) expect(out).not.toHaveProperty(k);
    const m = out.messages;
    expect(m[0]).toEqual({ role: ROLE.SYSTEM, content: "sys" });
    expect(m[1].content[1]).toEqual({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: "https://x/y.png", detail: "auto" } });
    expect(m[1].content[2].image_url).toEqual({ url: "f1", detail: "high" });
    expect(m[1].content[3]).toEqual({ type: "other", z: 1 });
    expect(m[2].tool_calls.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(m[3]).toEqual({ role: ROLE.TOOL, tool_call_id: "c1", content: "r1" });
    expect(m[4]).toEqual({ role: ROLE.TOOL, tool_call_id: "c2", content: "{\"ok\":true}" });
    expect(m[5]).toEqual({ role: ROLE.ASSISTANT, content: [{ type: OPENAI_BLOCK.TEXT, text: "done" }] });
    expect(m[6].tool_calls[0].id).toBe("c3");
  });

  it("handles string input, trailing tool outputs and type-less role items", () => {
    const out = convertResponsesApiFormat({ input: "hello" });
    expect(out.messages).toEqual([{ role: ROLE.USER, content: [{ type: OPENAI_BLOCK.TEXT, text: "hello" }] }]);
    const t = convertResponsesApiFormat({ input: [{ type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: "z", output: "o" }] });
    expect(t.messages).toEqual([{ role: ROLE.TOOL, tool_call_id: "z", content: "o" }]);
    const u = convertResponsesApiFormat({ input: [{ role: ROLE.USER, content: "plain" }] });
    expect(u.messages[0].content).toBe("plain");
  });
});
