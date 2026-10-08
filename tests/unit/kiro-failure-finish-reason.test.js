import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args)
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { createDisconnectAwareStream, pipeWithDisconnect, createStreamController } =
  await import("../../open-sse/utils/streamHandler.js");
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

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

function frame(eventType, payload) {
  const name = encoder.encode(":event-type");
  const value = encoder.encode(eventType);
  const header = new Uint8Array(1 + name.length + 3 + value.length);
  header[0] = name.length;
  header.set(name, 1);
  header[1 + name.length] = 7;
  new DataView(header.buffer).setUint16(2 + name.length, value.length, false);
  header.set(value, 4 + name.length);
  const body = encoder.encode(JSON.stringify(payload));
  const total = 12 + header.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, header.length, false);
  out.set(header, 12);
  out.set(body, 12 + header.length);
  view.setUint32(8, crc32(out.subarray(0, 8)), false);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)), false);
  return out;
}

const response = (frames) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(f); c.close(); }
}), { status: 200 });

const execute = (overrides = {}) => new KiroExecutor().execute({
  model: "kr/claude-opus-4.8",
  body: { conversationState: { currentMessage: { userInputMessage: { content: "base", modelId: "m" } } } },
  stream: false,
  credentials,
  ...overrides
});

// Parsed data frames + whether [DONE] came last.
function parse(body) {
  const datas = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const frames = datas.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
  return { frames, doneLast: datas.at(-1) === "[DONE]", error: frames.find((f) => f.error)?.error,
    finish: frames.flatMap((f) => f.choices || []).map((c) => c.finish_reason).filter(Boolean) };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

beforeEach(() => fetchMock.mockReset());

describe("Kiro fail() exits carry a finish_reason", () => {
  it("truncated frame at EOF (both attempts) -> error + finish_reason error + [DONE]", async () => {
    const cut = () => response([frame("assistantResponseEvent", { content: "x" }).slice(0, -3)]);
    fetchMock.mockResolvedValueOnce(cut()).mockResolvedValueOnce(cut());
    const p = parse(await (await execute()).response.text());
    expect(p.error).toBeTruthy();
    expect(p.finish).toEqual(["error"]);
    expect(p.doneLast).toBe(true);
  });

  it("empty stream at EOF -> finish_reason error", async () => {
    fetchMock.mockResolvedValue(response([]));
    const p = parse(await (await execute()).response.text());
    expect(p.error).toBeTruthy();
    expect(p.finish).toEqual(["error"]);
    expect(p.doneLast).toBe(true);
  });

  it.each([["cancelled"], ["content_filtered"], ["something_unknown"]])(
    "stop reason %s -> finish_reason error", async (stopReason) => {
      fetchMock.mockResolvedValue(response([
        frame("assistantResponseEvent", { content: "partial" }),
        frame("metadataEvent", { stopReason })
      ]));
      const p = parse(await (await execute()).response.text());
      expect(p.error).toBeTruthy();
      expect(p.finish).toEqual(["error"]);
      expect(p.doneLast).toBe(true);
    });

  it.each([["model_context_window_exceeded"]])(
    "%s with zero output chunks -> finish_reason error (retryable)", async (stopReason) => {
      fetchMock.mockResolvedValue(response([frame("metadataEvent", { stopReason })]));
      const p = parse(await (await execute()).response.text());
      expect(p.finish).toEqual(["error"]);
      expect(p.doneLast).toBe(true);
    });

  it("max_tokens after output still finishes with length", async () => {
    fetchMock.mockResolvedValue(response([
      frame("assistantResponseEvent", { content: "some" }),
      frame("metadataEvent", { stopReason: "max_tokens" })
    ]));
    const p = parse(await (await execute()).response.text());
    expect(p.finish).toEqual(["length"]);
  });

  it("missing response body -> finish_reason error", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null, headers: new Headers() });
    const result = await execute();
    const p = parse(await result.response.text());
    expect(p.finish).toEqual(["error"]);
    expect(p.doneLast).toBe(true);
  });
});

describe("gateway abort terminals carry a finish_reason (OpenAI chat)", () => {
  const ctrlStub = () => ({
    signal: new AbortController().signal, startTime: Date.now(), isConnected: () => true,
    handleComplete() {}, handleError() {}, handleDisconnect() {}, abort() {}
  });

  it("ECONNRESET through the disconnect-aware stream", async () => {
    const upstream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode("data: hi\n\n"));
        const err = new Error("read ECONNRESET");
        err.code = "ECONNRESET";
        c.error(err);
      }
    });
    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      ctrlStub(),
      (msg) => buildStreamErrorBytes(504, msg, FORMATS.OPENAI)
    );
    const p = parse(await readAll(out));
    expect(p.error).toBeTruthy();
    expect(p.finish).toEqual(["error"]);
    expect(p.doneLast).toBe(true);
  });

  it("stall timeout with a stubbed timer", async () => {
    vi.useFakeTimers();
    try {
      const ctrl = createStreamController({ provider: "kiro", model: "test" });
      const upstream = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
          ctrl.signal.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
        }
      });
      const out = pipeWithDisconnect({ body: upstream }, new TransformStream(), ctrl,
        (msg) => buildStreamErrorBytes(504, msg, FORMATS.OPENAI), 1000);
      const pending = readAll(out);
      await vi.advanceTimersByTimeAsync(5000);
      const p = parse(await pending);
      expect(p.error.message).toContain("stall");
      expect(p.finish).toEqual(["error"]);
      expect(p.doneLast).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Claude format is unchanged (event: error, no finish chunk, no [DONE])", () => {
    const out = new TextDecoder().decode(buildStreamErrorBytes(504, "x", FORMATS.CLAUDE));
    expect(out).toContain("event: error");
    expect(out).not.toContain("finish_reason");
    expect(out).not.toContain("[DONE]");
  });

  it("other non-OpenAI formats keep error + [DONE] without finish chunk", () => {
    const out = new TextDecoder().decode(buildStreamErrorBytes(504, "x", FORMATS.GEMINI));
    expect(out).not.toContain("finish_reason");
    expect(out).toContain("[DONE]");
  });
});

describe("stream keepalive", () => {
  const mkCtl = () => ({ isConnected: () => true, handleComplete() {}, handleError() {}, handleDisconnect() {}, abort() {} });
  const dec = new TextDecoder();
  const fakeW = { getWriter: () => ({ abort: () => Promise.resolve() }) };

  it("emits SSE comment keepalives during quiet stretches without losing data", async () => {
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const reader = createDisconnectAwareStream({ readable: ts.readable, writable: fakeW }, mkCtl(), null, 20).getReader();
    expect(dec.decode((await reader.read()).value)).toBe(": keepalive\n\n");
    await writer.write(encoder.encode("data: hi\n\n"));
    let got = "";
    for (let i = 0; i < 5 && !got.includes("data: hi"); i++) got += dec.decode((await reader.read()).value);
    expect(got).toContain("data: hi\n\n");
    await writer.close();
  });

  it("emits no keepalive when disabled", async () => {
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const reader = createDisconnectAwareStream({ readable: ts.readable, writable: fakeW }, mkCtl(), null, 0).getReader();
    await writer.write(encoder.encode("data: x\n\n"));
    await writer.close();
    expect(dec.decode((await reader.read()).value)).toBe("data: x\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("keepalives do not reset the upstream stall timer", async () => {
    const body = new ReadableStream({ start() {} });
    let connected = true;
    const ctl = { ...mkCtl(), isConnected: () => connected, handleError: vi.fn(), abort: vi.fn(() => { connected = false; }) };
    const out = pipeWithDisconnect({ body }, new TransformStream(), ctl,
      () => encoder.encode("data: [DONE]\n\n"), 120, 30);
    const reader = out.getReader();
    const seen = [];
    for (let i = 0; i < 20; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(dec.decode(value));
    }
    expect(seen).toContain(": keepalive\n\n");
    expect(ctl.handleError).toHaveBeenCalled();
    expect(seen[seen.length - 1]).toContain("[DONE]");
  });
});
