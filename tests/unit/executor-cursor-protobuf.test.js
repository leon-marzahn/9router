// Cursor executor, legacy ChatService path: ConnectRPC/protobuf frame parsing
// (gzip frames, truncated frames, JSON error frames, streamed tool calls) for both
// JSON and SSE outputs, plus execute() error mapping via the fetch transport.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import zlib from "node:zlib";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (...args) => {
    const r = await fetchMock(...args);
    if (r instanceof Error) throw r;
    return r;
  },
}));

const { CursorExecutor } = await import("../../open-sse/executors/cursor.js");
const { encodeField } = await import("../../open-sse/utils/cursorProtobuf.js");

const LEN = 2;
const VARINT = 0;
const buf = (u8) => Buffer.from(u8);

function frame(payload, flags = 0) {
  const body = flags & 1 ? zlib.gzipSync(payload) : payload;
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
const textPayload = (text) => buf(encodeField(2, LEN, buf(encodeField(1, LEN, text))));
function toolPayload({ id, name, args = "", isLast = false }) {
  const parts = [encodeField(3, LEN, id), encodeField(9, LEN, name)];
  if (args) parts.push(encodeField(10, LEN, args));
  if (isLast) parts.push(encodeField(11, VARINT, 1));
  return buf(encodeField(1, LEN, Buffer.concat(parts.map(buf))));
}
const jsonError = (obj) => Buffer.from(JSON.stringify(obj));

function sseEvents(text) {
  return text.split("\n\n").filter(c => c.startsWith("data: ") && !c.includes("[DONE]")).map(c => JSON.parse(c.slice(6)));
}

const body = { messages: [{ role: "user", content: "hi" }] };
const creds = { accessToken: "cursor-SECRET-token", providerSpecificData: { machineId: "mid" } };

beforeEach(() => fetchMock.mockReset());

describe("CursorExecutor.transformProtobufToJSON", () => {
  it("concatenates text across plain and gzip frames, ignoring a truncated trailing frame", async () => {
    const full = frame(textPayload("lo"));
    const buffer = Buffer.concat([frame(textPayload("Hel")), frame(textPayload(" wor"), 1), frame(textPayload("ld")), full.subarray(0, full.length - 2)]);
    const j = await new CursorExecutor().transformProtobufToJSON(buffer, "gpt-5", body).json();
    expect(j.choices[0].message.content).toBe("Hel world");
    expect(j.choices[0].finish_reason).toBe("stop");
    expect(j.object).toBe("chat.completion");
  });

  it("accumulates tool-call argument deltas by id and finalizes on isLast or at end", async () => {
    const buffer = Buffer.concat([
      frame(toolPayload({ id: "call_1\nextra", name: "read", args: '{"p":' })),
      frame(toolPayload({ id: "call_1", name: "read", args: '"a"}', isLast: true })),
      frame(toolPayload({ id: "call_2", name: "ls", args: "{}" })),
    ]);
    const j = await new CursorExecutor().transformProtobufToJSON(buffer, "gpt-5", body).json();
    const tcs = j.choices[0].message.tool_calls;
    expect(tcs.map(t => t.id)).toEqual(["call_1", "call_2"]);
    expect(tcs[0].function).toEqual({ name: "read", arguments: '{"p":"a"}' });
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(j.choices[0].message.content).toBeNull();
  });

  it("JSON error frame before content → 429 for resource_exhausted, 400 otherwise", async () => {
    const ex = new CursorExecutor();
    const rl = ex.transformProtobufToJSON(frame(jsonError({ error: { code: "resource_exhausted", message: "slow down", details: [{ debug: { error: "ERR_RL", details: { title: "Too many" } } }] } })), "gpt-5", body);
    expect(rl.status).toBe(429);
    expect((await rl.json()).error).toMatchObject({ message: "Too many", type: "rate_limit_error", code: "ERR_RL" });
    const other = ex.transformProtobufToJSON(frame(jsonError({ error: { code: "invalid", message: "bad model" } })), "gpt-5", body);
    expect(other.status).toBe(400);
    expect((await other.json()).error.message).toBe("bad model");
  });

  it("JSON error frame after content keeps the partial answer", async () => {
    const buffer = Buffer.concat([frame(textPayload("partial")), frame(jsonError({ error: { message: "late" } }))]);
    const r = new CursorExecutor().transformProtobufToJSON(buffer, "gpt-5", body);
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("partial");
  });

  it("undecodable gzip-flagged frame is passed through without throwing", async () => {
    const bad = Buffer.concat([Buffer.from([1, 0, 0, 0, 4]), Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
    const r = new CursorExecutor().transformProtobufToJSON(Buffer.concat([bad, frame(textPayload("ok"))]), "gpt-5", body);
    expect((await r.json()).choices[0].message.content).toBe("ok");
  });
});

describe("CursorExecutor.transformProtobufToSSE", () => {
  it("first text chunk carries role, then content deltas, then finish + usage and [DONE]", async () => {
    const r = new CursorExecutor().transformProtobufToSSE(Buffer.concat([frame(textPayload("A")), frame(textPayload("B"), 1)]), "gpt-5", body);
    const text = await r.text();
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const ev = sseEvents(text);
    expect(ev[0].choices[0].delta).toEqual({ role: "assistant", content: "A" });
    expect(ev[1].choices[0].delta).toEqual({ content: "B" });
    expect(ev.at(-1).choices[0].finish_reason).toBe("stop");
    expect(ev.at(-1).usage).toBeTruthy();
  });

  it("streams tool calls with stable indexes and argument deltas", async () => {
    const buffer = Buffer.concat([
      frame(toolPayload({ id: "c1", name: "read", args: '{"a":' })),
      frame(toolPayload({ id: "c1", name: "read", args: "1}", isLast: true })),
      frame(toolPayload({ id: "c2", name: "ls" })),
    ]);
    const ev = sseEvents(await new CursorExecutor().transformProtobufToSSE(buffer, "gpt-5", body).text());
    expect(ev[0].choices[0].delta.role).toBe("assistant");
    const tc = ev.flatMap(e => e.choices[0].delta.tool_calls || []);
    expect(tc.filter(t => t.id === "c1").map(t => t.function.arguments).join("")).toBe('{"a":1}');
    expect(tc.find(t => t.id === "c1").index).toBe(0);
    expect(tc.find(t => t.id === "c2").index).toBe(1);
    expect(ev.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("empty buffer still yields a role chunk and a stop chunk", async () => {
    const ev = sseEvents(await new CursorExecutor().transformProtobufToSSE(Buffer.alloc(0), "gpt-5", body).text());
    expect(ev[0].choices[0].delta.role).toBe("assistant");
    expect(ev.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("JSON error frame first → error response; after content → truncated stream", async () => {
    const ex = new CursorExecutor();
    expect(ex.transformProtobufToSSE(frame(jsonError({ error: { code: "resource_exhausted" } })), "gpt-5", body).status).toBe(429);
    const r = ex.transformProtobufToSSE(Buffer.concat([frame(textPayload("x")), frame(jsonError({ error: { message: "e" } })), frame(textPayload("never"))]), "gpt-5", body);
    const text = await r.text();
    expect(text).toContain('"x"');
    expect(text).not.toContain("never");
  });
});

describe("CursorExecutor.execute (legacy ChatService via fetch transport)", () => {
  // An image part makes the request non-agent-capable, forcing the legacy protobuf path;
  // an enabled proxy forces fetch instead of raw http2.
  const imgBody = { messages: [{ role: "user", content: [{ type: "text", text: "what" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  const proxyOptions = { enabled: true };

  it("requires a machine id", () => {
    expect(() => new CursorExecutor().buildHeaders({ accessToken: "t" })).toThrow(/Machine ID/);
  });

  it("decodes a 200 protobuf body into a JSON completion", async () => {
    fetchMock.mockResolvedValueOnce(new Response(frame(textPayload("seen")), { status: 200 }));
    const out = await new CursorExecutor().execute({ model: "gpt-5", body: imgBody, stream: false, credentials: creds, proxyOptions });
    expect((await out.response.json()).choices[0].message.content).toBe("seen");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\//);
    expect(init.method).toBe("POST");
    expect(JSON.stringify(init.headers)).toContain("cursor-SECRET-token");
  });

  it("non-200 upstream maps to same status with upstream text", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const out = await new CursorExecutor().execute({ model: "gpt-5", body: imgBody, stream: true, credentials: creds, proxyOptions });
    expect(out.response.status).toBe(401);
    expect((await out.response.json()).error.message).toBe("[401]: unauthorized");
  });

  it("network error → 500 connection_error without the access token", async () => {
    fetchMock.mockResolvedValueOnce(new Error("socket hang up"));
    const out = await new CursorExecutor().execute({ model: "gpt-5", body: imgBody, stream: true, credentials: creds, proxyOptions });
    expect(out.response.status).toBe(500);
    const text = await out.response.text();
    expect(text).toContain("socket hang up");
    expect(text).not.toContain("cursor-SECRET-token");
  });

  it("refreshCredentials is a no-op", async () => {
    expect(await new CursorExecutor().refreshCredentials()).toBeNull();
  });
});
