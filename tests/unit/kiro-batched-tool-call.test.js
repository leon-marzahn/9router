/**
 * Kiro's generic `tool_call` wrapper in BATCH form: input {calls:[{name, arguments}, ...]}.
 * Each element must become its own OpenAI tool_call (index, derived id
 * `<wrapperId>#<n>`); any invalid element drops the whole payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args)
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { kiroToClaudeResponse } = await import(
  "../../open-sse/translator/response/kiro-to-claude.js"
);

const encoder = new TextEncoder();
const credentials = { accessToken: "test-token", providerSpecificData: { kiroToolCallRepair: true } };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const bytes = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
  let offset = 0;
  bytes[offset++] = nameBytes.length;
  bytes.set(nameBytes, offset);
  offset += nameBytes.length;
  bytes[offset++] = 7;
  new DataView(bytes.buffer).setUint16(offset, valueBytes.length, false);
  offset += 2;
  bytes.set(valueBytes, offset);
  return bytes;
}

function frame(eventType, payload) {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const total = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headers.byteLength, false);
  out.set(headers, 12);
  out.set(payloadBytes, 12 + headers.byteLength);
  view.setUint32(8, crc32(out.subarray(0, 8)), false);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)), false);
  return out;
}

function response(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    }
  }), { status: 200, statusText: "OK" });
}

async function run(frames, { retryFrames } = {}) {
  fetchMock.mockResolvedValueOnce(response(frames));
  if (retryFrames) fetchMock.mockResolvedValueOnce(response(retryFrames));
  const result = await new KiroExecutor().execute({
    model: "kr/claude-opus-4.8",
    body: { systemPrompt: "base", conversationState: {} },
    stream: true,
    credentials
  });
  return await result.response.text();
}

function chunksOf(body) {
  return body.split("\n")
    .filter(line => line.startsWith("data: ") && line.slice(6) !== "[DONE]")
    .map(line => { try { return JSON.parse(line.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

// Collapse streamed deltas into [{id, name, arguments}] ordered by index.
function toolCallsFrom(body) {
  const calls = new Map();
  for (const chunk of chunksOf(body)) {
    for (const choice of chunk.choices || []) {
      for (const tc of choice.delta?.tool_calls || []) {
        const cur = calls.get(tc.index) || { index: tc.index, id: undefined, name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
  }
  return [...calls.values()].sort((a, b) => a.index - b.index);
}

function finishReasons(body) {
  return chunksOf(body).flatMap(c => (c.choices || []).map(ch => ch.finish_reason)).filter(Boolean);
}

function toolFrame(id, input, name = "tool_call") {
  return frame("toolUseEvent", { toolUseId: id, name, input });
}

const STOP = frame("metadataEvent", { stopReason: "tool_use" });
const calls2 = [
  { name: "mcp_read", arguments: { path: "a.txt" } },
  { name: "mcp_search", arguments: { query: "x" } }
];
const calls3 = [...calls2, { name: "mcp_list", arguments: "{\"dir\":\".\"}" }];

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("batched tool_call wrapper", () => {
  it("emits a batch of 2 as two separate tool calls", async () => {
    const body = await run([toolFrame("w1", { calls: calls2 }), STOP]);
    const out = toolCallsFrom(body);
    expect(out.map(c => c.id)).toEqual(["w1_0", "w1_1"]);
    expect(out.map(c => c.index)).toEqual([0, 1]);
    expect(out.every(c => c.name === "tool_call")).toBe(true);
    expect(out.map(c => JSON.parse(c.arguments))).toEqual(calls2);
    expect(finishReasons(body)).toContain("tool_calls");
  });

  it("emits a batch of 3", async () => {
    const body = await run([toolFrame("w1", { calls: calls3 }), STOP]);
    const out = toolCallsFrom(body);
    expect(out).toHaveLength(3);
    expect(new Set(out.map(c => c.id)).size).toBe(3);
    expect(JSON.parse(out[2].arguments)).toEqual(calls3[2]);
  });

  it("reassembles a batch split across many string chunks", async () => {
    const json = JSON.stringify({ calls: calls3 });
    const frames = [];
    for (let i = 0; i < json.length; i += 7) frames.push(toolFrame("w1", json.slice(i, i + 7)));
    const body = await run([...frames, STOP]);
    const out = toolCallsFrom(body);
    expect(out.map(c => c.id)).toEqual(["w1_0", "w1_1", "w1_2"]);
    expect(finishReasons(body)).toContain("tool_calls");
  });

  it("handles a single call plus a batch in one turn", async () => {
    const body = await run([
      toolFrame("s1", { name: "mcp_one", arguments: {} }),
      toolFrame("w2", { calls: calls2 }),
      STOP
    ]);
    const out = toolCallsFrom(body);
    expect(out.map(c => c.id)).toEqual(["s1", "w2_0", "w2_1"]);
    expect(out.map(c => c.index)).toEqual([0, 1, 2]);
  });

  it("drops the whole payload when one element is invalid (no partial emit)", async () => {
    const bad = { calls: [calls2[0], { name: "", arguments: {} }] };
    const stop = [STOP];
    const body = await run([toolFrame("w1", bad), ...stop], { retryFrames: [toolFrame("w1", bad), ...stop] });
    expect(toolCallsFrom(body)).toEqual([]);
    expect(body).toContain("invalid_kiro_tool_call");
    const logged = console.error.mock.calls.map(c => c.join(" ")).join("\n");
    expect(logged).toContain("batch=");
    expect(logged).not.toContain("a.txt");
  });

  it("rejects an element missing arguments", async () => {
    const bad = { calls: [{ name: "mcp_read" }] };
    const body = await run([toolFrame("w1", bad), STOP], { retryFrames: [toolFrame("w1", bad), STOP] });
    expect(toolCallsFrom(body)).toEqual([]);
  });

  it("rejects an empty calls array", async () => {
    const body = await run([toolFrame("w1", { calls: [] }), STOP], { retryFrames: [toolFrame("w1", { calls: [] }), STOP] });
    expect(toolCallsFrom(body)).toEqual([]);
    expect(body).toContain("invalid_kiro_tool_call");
  });

  it("rejects non-array calls", async () => {
    const p = { calls: { name: "x", arguments: {} } };
    const body = await run([toolFrame("w1", p), STOP], { retryFrames: [toolFrame("w1", p), STOP] });
    expect(toolCallsFrom(body)).toEqual([]);
  });

  it("rejects a wrapper with both name and calls", async () => {
    const p = { name: "mcp_read", arguments: {}, calls: calls2 };
    const body = await run([toolFrame("w1", p), STOP], { retryFrames: [toolFrame("w1", p), STOP] });
    expect(toolCallsFrom(body)).toEqual([]);
  });

  it("keeps the single {name, arguments} form unchanged", async () => {
    const body = await run([toolFrame("s1", { name: "mcp_one", arguments: { a: 1 } }), STOP]);
    const out = toolCallsFrom(body);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("s1");
    expect(JSON.parse(out[0].arguments)).toEqual({ name: "mcp_one", arguments: { a: 1 } });
  });

  it("produces one tool_use block per call on the Claude path", async () => {
    const body = await run([toolFrame("w1", { calls: calls3 }), STOP]);
    const state = {};
    const events = chunksOf(body).flatMap(chunk => kiroToClaudeResponse(chunk, state) || []);
    const starts = events.filter(e => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts).toHaveLength(3);
    expect(starts.map(e => e.content_block.id)).toEqual(["w1_0", "w1_1", "w1_2"]);
    expect(events.find(e => e.type === "message_delta")?.delta?.stop_reason).toBe("tool_use");
  });
});
