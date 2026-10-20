// /v1/api/chat (Ollama shim): the OpenAI response the gateway produces must come
// back as Ollama's format — a full message for stream:false, and exactly one
// done:true line when streaming.
import { describe, expect, it } from "vite-plus/test";
import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const sse = (events) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const lines = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

describe("transformToOllama", () => {
  it("returns the full message for a non-streaming completion", async () => {
    const body = {
      choices: [{ message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const res = await transformToOllama(Response.json(body), "llama3.2");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({
      model: "llama3.2",
      message: { role: "assistant", content: "Hello there" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 5,
      eval_count: 2,
    });
  });

  it("keeps tool calls in a non-streaming completion", async () => {
    const body = {
      choices: [{
        message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
        finish_reason: "tool_calls",
      }],
    };
    const out = await (await transformToOllama(Response.json(body), "m")).json();
    expect(out.message).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: { a: 1 } } }] });
  });

  it("streams content and ends with exactly one done line", async () => {
    const res = await transformToOllama(sse([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      "[DONE]",
    ]), "m");
    const out = await lines(res);
    expect(out.filter((l) => l.done)).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 });
    expect(out.filter((l) => !l.done).map((l) => l.message.content).join("")).toBe("Hello");
  });

  it("emits one done line with the tool calls when streaming tool use", async () => {
    const out = await lines(await transformToOllama(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    ]), "m"));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ done: false, message: { tool_calls: [{ function: { name: "f", arguments: { a: 1 } } }] } });
    expect(out[1].done).toBe(true);
    expect(out[1].message.tool_calls).toBeUndefined();
  });

  it("still ends with one done line when the stream has no [DONE]", async () => {
    const out = await lines(await transformToOllama(sse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]), "m"));
    expect(out.filter((l) => l.done)).toHaveLength(1);
    expect(out.at(-1).done_reason).toBe("stop");
  });

  it("does not mark a cut-off stream (no finish_reason, no [DONE]) as stopped", async () => {
    const out = await lines(await transformToOllama(sse([{ choices: [{ delta: { content: "par" } }] }]), "m"));
    expect(out.filter((l) => l.done)).toHaveLength(1);
    expect(out.at(-1).done_reason).toBeUndefined();
  });

  it("turns the gateway's mid-stream error tail into an error line and no done_reason", async () => {
    const out = await lines(await transformToOllama(sse([
      { choices: [{ delta: { content: "par" } }] },
      { error: { message: "upstream connection lost", type: "upstream_error" } },
      { choices: [{ delta: {}, finish_reason: "error" }] },
      "[DONE]",
    ]), "m"));
    expect(out.find((l) => l.error)).toEqual({ error: "upstream connection lost" });
    expect(out.filter((l) => l.done)).toHaveLength(1);
    expect(out.at(-1).done_reason).toBeUndefined();
  });

  it("rewrites errors to Ollama's { error } shape, keeping the status", async () => {
    const cases = [
      [Response.json({ error: { message: "bad key" } }, { status: 401 }), 401, "bad key"],
      [Response.json({ error: "rate limited" }, { status: 429 }), 429, "rate limited"],
      [new Response("upstream down", { status: 502 }), 502, "upstream down"],
    ];
    for (const [input, status, error] of cases) {
      const res = await transformToOllama(input, "m");
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });
});
