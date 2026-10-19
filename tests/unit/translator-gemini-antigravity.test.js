// Gemini / Antigravity <-> OpenAI pivot: tool id pairing, thinking parts, images, finish/usage mapping.
import { describe, it, expect } from "vite-plus/test";
import { geminiToOpenAIRequest } from "../../open-sse/translator/request/gemini-to-openai.js";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.js";
import { openaiToAntigravityResponse } from "../../open-sse/translator/response/openai-to-antigravity.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK, OPENAI_FINISH, GEMINI_FINISH } from "../../open-sse/translator/schema/index.js";

const B64 = "iVBORw0KGgo=";

describe("geminiToOpenAIRequest", () => {
  it("maps generationConfig, systemInstruction and tools", () => {
    const out = geminiToOpenAIRequest("m", {
      generationConfig: { maxOutputTokens: 100, temperature: 0.2, topP: 0.9 },
      systemInstruction: { parts: [{ text: "a" }, { text: "b" }] },
      tools: [{ functionDeclarations: [{ name: "f" }, { name: "g", description: "d", parameters: { type: "object" } }] }],
      contents: [{ role: GEMINI_ROLE.USER, parts: [{ text: "hi" }] }],
    }, true);
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBeGreaterThan(0);
    expect(out.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "ab" });
    expect(out.messages[1].role).toBe(ROLE.USER);
    expect(out.tools[0].function).toEqual({ name: "f", description: "", parameters: { type: "object", properties: {} } });
    expect(out.tools[1].function.description).toBe("d");
  });

  it("accepts a string systemInstruction and skips empty ones", () => {
    expect(geminiToOpenAIRequest("m", { systemInstruction: "sys" }).messages[0].content).toBe("sys");
    expect(geminiToOpenAIRequest("m", { systemInstruction: { parts: [] } }).messages).toHaveLength(0);
    expect(geminiToOpenAIRequest("m", { systemInstruction: {} }).messages).toHaveLength(0);
  });

  it("pairs functionCall and functionResponse with the same tool_call_id when no id is given", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [
        { role: GEMINI_ROLE.MODEL, parts: [{ functionCall: { name: "read", args: { p: 1 } } }] },
        { role: GEMINI_ROLE.USER, parts: [{ functionResponse: { name: "read", response: { result: "ok" } } }] },
      ],
    });
    const [call, result] = out.messages;
    expect(call.role).toBe(ROLE.ASSISTANT);
    expect(call.tool_calls[0].function).toEqual({ name: "read", arguments: JSON.stringify({ p: 1 }) });
    expect(result.role).toBe(ROLE.TOOL);
    expect(result.tool_call_id).toBe(call.tool_calls[0].id);
    expect(result.content).toBe(JSON.stringify("ok"));
  });

  it("keeps explicit ids, empty args and whole response objects", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [
        { role: GEMINI_ROLE.MODEL, parts: [{ text: "calling" }, { functionCall: { id: "c1", name: "x" } }] },
        { role: GEMINI_ROLE.USER, parts: [{ functionResponse: { id: "c1", name: "x", response: { a: 1 } } }] },
        { role: GEMINI_ROLE.USER, parts: [{ functionResponse: { name: "y" } }] },
      ],
    });
    expect(out.messages[0].content).toBe("calling");
    expect(out.messages[0].tool_calls[0]).toMatchObject({ id: "c1", function: { arguments: "{}" } });
    expect(out.messages[1]).toEqual({ role: ROLE.TOOL, tool_call_id: "c1", content: JSON.stringify({ a: 1 }) });
    expect(out.messages[2].content).toBe("{}");
  });

  it("converts inlineData to a base64 data URI image_url and drops part-less contents", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [
        { role: GEMINI_ROLE.USER, parts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: B64 } }] },
        { role: GEMINI_ROLE.USER },
        { role: GEMINI_ROLE.USER, parts: [] },
      ],
    });
    expect(out.messages).toHaveLength(1);
    const img = out.messages[0].content.find((p) => p.type === OPENAI_BLOCK.IMAGE_URL);
    expect(img.image_url.url).toBe(`data:image/png;base64,${B64}`);
  });

  it("keeps every functionResponse in a single content (parallel tool results)", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{ role: GEMINI_ROLE.USER, parts: [
        { functionResponse: { id: "a", name: "f", response: {} } },
        { functionResponse: { id: "b", name: "g", response: {} } },
      ] }],
    });
    expect(out.messages.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  it("keeps text sent alongside functionResponses as a following message", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{ role: GEMINI_ROLE.USER, parts: [
        { functionResponse: { id: "a", name: "f", response: { result: 1 } } },
        { text: "continue" },
      ] }],
    });
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "user", content: "continue" },
    ]);
  });

  it("keeps a lone image next to a functionCall", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{ role: GEMINI_ROLE.MODEL, parts: [
        { inlineData: { mimeType: "image/png", data: B64 } },
        { functionCall: { name: "f" } },
      ] }],
    });
    expect(out.messages[0].content).toEqual([
      { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: `data:image/png;base64,${B64}` } },
    ]);
    expect(out.messages[0].tool_calls).toHaveLength(1);
  });

  it("still collapses a lone text part next to a functionCall to a string", () => {
    const out = geminiToOpenAIRequest("m", {
      contents: [{ role: GEMINI_ROLE.MODEL, parts: [{ text: "calling" }, { functionCall: { name: "f" } }] }],
    });
    expect(out.messages[0].content).toBe("calling");
  });
});

describe("antigravityToOpenAIRequest", () => {
  it("unwraps body.request, maps thinking budget, topK and normalizes schema types", () => {
    const out = antigravityToOpenAIRequest("m", {
      project: "p",
      request: {
        generationConfig: { maxOutputTokens: 50, temperature: 0, topP: 1, topK: 40, thinkingConfig: { thinkingBudget: 32000 } },
        systemInstruction: { parts: [{ text: "sys" }] },
        tools: [{ functionDeclarations: [
          { name: "f", parameters: { type: "OBJECT", properties: { a: { type: "STRING", enumDescriptions: ["x"] }, l: { type: "ARRAY", items: { type: "NUMBER" } } } } },
          { name: "g" },
        ] }, {}],
        contents: [{ role: GEMINI_ROLE.USER, parts: [{ text: "hi" }] }],
      },
    }, false);
    expect(out.temperature).toBe(0);
    expect(out.top_p).toBe(1);
    expect(out.top_k).toBe(40);
    expect(out.reasoning_effort).toBeTruthy();
    expect(out.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "sys" });
    const params = out.tools[0].function.parameters;
    expect(params.type).toBe("object");
    expect(params.properties.a).toEqual({ type: "string" });
    expect(params.properties.l.items.type).toBe("number");
    expect(out.tools[1].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("works on a bare body and string systemInstruction", () => {
    const out = antigravityToOpenAIRequest("m", { systemInstruction: "s", contents: [{ role: GEMINI_ROLE.USER }] });
    expect(out.messages).toEqual([{ role: ROLE.SYSTEM, content: "s" }]);
  });

  it("turns thought parts into reasoning_content and keeps signed text as content", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [{ role: GEMINI_ROLE.MODEL, parts: [
      { thought: true, text: "think" },
      { thoughtSignature: "sig", text: "answer" },
      { thoughtSignature: "sig", text: "" },
    ] }] });
    expect(out.messages[0]).toMatchObject({ role: ROLE.ASSISTANT, reasoning_content: "think", content: "answer" });
  });

  it("emits reasoning-only assistant messages", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [{ role: GEMINI_ROLE.MODEL, parts: [{ thought: true, text: "t" }] }] });
    expect(out.messages[0]).toEqual({ role: ROLE.ASSISTANT, reasoning_content: "t" });
  });

  it("assistant with reasoning + text + tool call keeps all three", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [{ role: GEMINI_ROLE.MODEL, parts: [
      { thought: true, text: "t" }, { text: "x" }, { functionCall: { name: "f", args: { a: 1 } } },
    ] }] });
    expect(out.messages[0]).toMatchObject({ reasoning_content: "t", content: "x" });
    expect(out.messages[0].tool_calls[0].id).toBe("call_f");
  });

  it("splits parallel functionResponses into separate tool messages with paired ids", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [
      { role: GEMINI_ROLE.MODEL, parts: [{ functionCall: { name: "a" } }, { functionCall: { name: "b" } }] },
      { role: GEMINI_ROLE.USER, parts: [
        { functionResponse: { name: "a", response: { result: 1 } } },
        { functionResponse: { id: "x", name: "b", response: { v: 2 } } },
        { functionResponse: { name: "c" } },
      ] },
    ] });
    expect(out.messages[0].tool_calls.map((t) => t.id)).toEqual(["call_a", "call_b"]);
    expect(out.messages.slice(1)).toEqual([
      { role: ROLE.TOOL, tool_call_id: "call_a", content: "1" },
      { role: ROLE.TOOL, tool_call_id: "x", content: JSON.stringify({ v: 2 }) },
      { role: ROLE.TOOL, tool_call_id: "call_c", content: "{}" },
    ]);
  });

  it("keeps co-located text/thinking/tool calls next to tool results", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [{ role: GEMINI_ROLE.MODEL, parts: [
      { functionResponse: { name: "a", response: {} } },
      { thought: true, text: "t" }, { text: "x" }, { functionCall: { name: "b" } },
    ] }] });
    expect(out.messages[0].role).toBe(ROLE.TOOL);
    expect(out.messages[1]).toMatchObject({ role: ROLE.ASSISTANT, content: "x", reasoning_content: "t" });
    expect(out.messages[1].tool_calls).toHaveLength(1);
  });

  it("encodes inlineData images as data URIs", () => {
    const out = antigravityToOpenAIRequest("m", { contents: [{ role: GEMINI_ROLE.USER, parts: [{ inlineData: { mimeType: "image/jpeg", data: B64 } }] }] });
    const img = out.messages[0].content[0];
    expect(img.image_url.url).toBe(`data:image/jpeg;base64,${B64}`);
  });
});

describe("openaiToAntigravityResponse (streaming)", () => {
  it("returns null for empty chunks and remembers usage-only chunks", () => {
    const state = {};
    expect(openaiToAntigravityResponse(null, state)).toBeNull();
    expect(openaiToAntigravityResponse({ usage: { prompt_tokens: 3 } }, state)).toBeNull();
    expect(state._usage).toEqual({ prompt_tokens: 3 });
    expect(openaiToAntigravityResponse({ choices: [] }, state)).toBeNull();
    expect(openaiToAntigravityResponse({ choices: [{ delta: {} }] }, state)).toBeNull();
  });

  it("emits thought and text parts with model role", () => {
    const state = {};
    const out = openaiToAntigravityResponse({ id: "r1", model: "gm", choices: [{ delta: { reasoning_content: "hm", content: "hi" } }] }, state);
    expect(out.response.responseId).toBe("r1");
    expect(out.response.modelVersion).toBe("gm");
    expect(out.response.candidates[0].content).toEqual({ role: GEMINI_ROLE.MODEL, parts: [{ thought: true, text: "hm" }, { text: "hi" }] });
    expect(out.response.candidates[0].finishReason).toBeUndefined();
  });

  it("accumulates tool-call fragments and emits one functionCall at finish, restoring cloaked names", () => {
    const state = { toolNameMap: new Map([["x_read", "read"]]) };
    expect(openaiToAntigravityResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x_", arguments: "{\"a\"" } }] } }] }, state)).toBeNull();
    expect(openaiToAntigravityResponse({ choices: [{ delta: { tool_calls: [{ function: { name: "read", arguments: ":1}" } }] } }] }, state)).toBeNull();
    openaiToAntigravityResponse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "bad", arguments: "{oops" } }] } }] }, state);
    const out = openaiToAntigravityResponse({
      choices: [{ delta: {}, finish_reason: OPENAI_FINISH.TOOL_CALLS }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { reasoning_tokens: 4 }, prompt_tokens_details: { cached_tokens: 5 } },
    }, state);
    const cand = out.response.candidates[0];
    expect(cand.content.parts).toEqual([
      { functionCall: { name: "read", args: { a: 1 } } },
      { functionCall: { name: "bad", args: {} } },
    ]);
    expect(cand.finishReason).toBe(GEMINI_FINISH.STOP);
    expect(out.response.usageMetadata).toEqual({
      promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3, thoughtsTokenCount: 4, cachedContentTokenCount: 5,
    });
  });

  it.each([
    [OPENAI_FINISH.STOP, GEMINI_FINISH.STOP],
    [OPENAI_FINISH.LENGTH, GEMINI_FINISH.MAX_TOKENS],
    [OPENAI_FINISH.CONTENT_FILTER, GEMINI_FINISH.SAFETY],
    ["weird", GEMINI_FINISH.STOP],
  ])("maps finish_reason %s -> %s with an empty text part and stored usage", (from, to) => {
    const state = { _usage: { prompt_tokens: 7 } };
    const out = openaiToAntigravityResponse({ choices: [{ delta: {}, finish_reason: from }] }, state);
    expect(out.response.candidates[0].finishReason).toBe(to);
    expect(out.response.candidates[0].content.parts).toEqual([{ text: "" }]);
    expect(out.response.usageMetadata).toEqual({ promptTokenCount: 7, candidatesTokenCount: 0, totalTokenCount: 0 });
    expect(out.response.responseId).toMatch(/^resp_/);
  });
});
