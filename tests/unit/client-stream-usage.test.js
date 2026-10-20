// What a streaming client sees as usage, per stream path. The request matrix covers the
// end-to-end cells; these pin the timing: content is never held, only the finish waits
// (bounded) for the upstream's usage trailer.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { jsonResponseToSSE } from "../../open-sse/handlers/chatCore/jsonToSSE.js";

const BUF = 2000;
const USAGE = { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 };
const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1700000000, model: "m" };
const line = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const contentChunk = line({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] });
const finishChunk = line({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const trailer = line({ ...base, choices: [], usage: USAGE });
const body = { model: "m", messages: [{ role: "user", content: "hi" }] };

/** A pipe whose upstream side the test drives chunk by chunk. */
function drive(transform) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let up;
  const upstream = new ReadableStream({ start: (c) => (up = c) });
  const reader = upstream.pipeThrough(transform).getReader();
  let text = "";
  // Read continuously in the background, as a client would.
  const finished = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (done) return text;
    }
  })();
  /** Wait until `pred(text)` or until `ticks` macrotasks passed. */
  const readUntil = async (pred, ticks = 20) => {
    for (let i = 0; i < ticks && !pred(text); i++) await new Promise((r) => setTimeout(r, 0));
    return text;
  };
  return {
    send: (s) => up.enqueue(encoder.encode(s)),
    end: () => up.close(),
    readUntil,
    readAll: () => finished,
    get text() {
      return text;
    },
  };
}

const claudeEvents = (text) =>
  text
    .split("\n\n")
    .map((b) => ({ event: b.match(/^event: (.+)$/m)?.[1], data: b.match(/^data: (.+)$/m)?.[1] }))
    .filter((e) => e.event)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) }));

afterEach(() => vi.useRealTimers());

describe("OpenAI client, passthrough stream", () => {
  it("folds an unrequested usage trailer into the finish chunk and drops it", async () => {
    // No stream_options sent upstream (strict node), but the upstream sends a trailer anyway.
    const s = drive(createPassthroughStreamWithLogger("test", null, "m", null, body, null, null, { awaitTrailer: true, dropTrailer: true }));
    s.send(contentChunk);
    expect(await s.readUntil((t) => t.includes("Hello"))).toContain("Hello");
    s.send(finishChunk + trailer + "data: [DONE]\n\n");
    s.end();
    const chunks = (await s.readAll())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks.filter((c) => c.usage && !c.choices.length)).toHaveLength(0);
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish.usage).toMatchObject({ prompt_tokens: USAGE.prompt_tokens + BUF, completion_tokens: USAGE.completion_tokens });
  });
});

describe("JSON answer replayed as an OpenAI stream", () => {
  const json = { id: "c1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3234, completion_tokens: 567, total_tokens: 3801 } };
  const trailers = (text) =>
    text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)))
      .filter((c) => !c.choices.length);

  it("adds the usage-only trailer with the real usage only when asked", () => {
    expect(trailers(jsonResponseToSSE(json, FORMATS.OPENAI))).toHaveLength(0);
    const text = jsonResponseToSSE(json, FORMATS.OPENAI, { includeUsage: true, realUsage: USAGE });
    expect(trailers(text)).toEqual([expect.objectContaining({ usage: USAGE })]);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
