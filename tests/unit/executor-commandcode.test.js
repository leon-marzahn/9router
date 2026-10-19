// CommandCode executor: auth/session headers, NDJSON → OpenAI SSE through execute(),
// early error-event detection (split chunks, data: prefix, trailing line), retry on 5xx
// error events and error-message → status mapping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (...args) => {
    const r = await fetchMock(...args);
    if (r instanceof Error) throw r;
    return r;
  },
}));

const { CommandCodeExecutor, parseCommandCodeError, inspectAndWrapCommandCodeResponse } = await import("../../open-sse/executors/commandcode.js");

function ndjsonRes(chunks, status = 200) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  }), { status });
}
const line = (o) => JSON.stringify(o) + "\n";

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.useRealTimers());

describe("CommandCodeExecutor request building", () => {
  it("Bearer from apiKey (or accessToken), fresh x-session-id per request, Accept on stream", () => {
    const ex = new CommandCodeExecutor();
    const a = ex.buildHeaders({ apiKey: "user_1" }, true);
    const b = ex.buildHeaders({ accessToken: "tok" }, false);
    expect(a.Authorization).toBe("Bearer user_1");
    expect(b.Authorization).toBe("Bearer tok");
    expect(a["x-session-id"]).not.toBe(b["x-session-id"]);
    expect(a.Accept).toBe("text/event-stream");
    expect(b.Accept).toBeUndefined();
    expect(ex.buildHeaders({}, false).Authorization).toBeUndefined();
  });

  it("forces stream:true upstream", () => {
    expect(new CommandCodeExecutor().transformRequest("m", { stream: false }).stream).toBe(true);
  });

  it("parseError: nested error object, top-level message, non-JSON body, empty body", () => {
    const ex = new CommandCodeExecutor();
    expect(ex.parseError({ status: 400 }, JSON.stringify({ error: { message: "bad", code: 422 } }))).toEqual({ status: 422, message: "bad" });
    expect(ex.parseError({ status: 500 }, JSON.stringify({ message: "m" }))).toEqual({ status: 500, message: "m" });
    expect(ex.parseError({ status: 502 }, "<html>")).toEqual({ status: 502, message: "<html>" });
    expect(ex.parseError({ status: 503, statusText: "" }, "")).toEqual({ status: 503, message: "CommandCode upstream error: 503" });
  });
});

describe("parseCommandCodeError mapping", () => {
  it.each([
    ["Rate limit exceeded", 429, "rate_limit_error"],
    ["Unauthorized", 401, "authentication_error"],
    ["Payment required", 402, "billing_error"],
    ["quota exhausted", 403, "permission_error"],
    ["model not found", 404, "invalid_request_error"],
    ["server overloaded", 503, "server_error"],
    ["weird", 503, "server_error"],
  ])("message %j → %i", (msg, status, type) => {
    expect(parseCommandCodeError({ type: "error", error: msg })).toMatchObject({ statusCode: status, type });
  });

  it("uses status/statusCode from the error object and top-level event; ignores out-of-range codes", () => {
    expect(parseCommandCodeError({ error: { message: "x", status: 418 } }).statusCode).toBe(418);
    expect(parseCommandCodeError({ error: "x", statusCode: 504 }).statusCode).toBe(504);
    expect(parseCommandCodeError({ error: { message: "unauthorized", statusCode: 200 } }).statusCode).toBe(401);
    expect(parseCommandCodeError({ error: 42 }).message).toBe("42");
    expect(parseCommandCodeError(null)).toEqual({ statusCode: 503, message: "CommandCode upstream error", type: "server_error" });
  });
});

describe("inspectAndWrapCommandCodeResponse", () => {
  it("detects an error event split across chunks with data: prefix", async () => {
    const ev = "data: " + JSON.stringify({ type: "error", error: { message: "Too many requests" } }) + "\n";
    const out = await inspectAndWrapCommandCodeResponse(ndjsonRes([line({ type: "start" }), ev.slice(0, 15), ev.slice(15)]), "m");
    expect(out.status).toBe(429);
    expect((await out.json()).error.message).toContain("Too many requests");
  });

  it("detects an error event on a trailing line without newline", async () => {
    const out = await inspectAndWrapCommandCodeResponse(ndjsonRes([JSON.stringify({ type: "error", error: "unavailable" })]), "m");
    expect(out.status).toBe(503);
  });

  it("replays already-read chunks and converts the rest to OpenAI SSE ending in [DONE]", async () => {
    const out = await inspectAndWrapCommandCodeResponse(ndjsonRes([
      line({ type: "start" }),
      "not json\n",
      line({ type: "text-delta", text: "Hel" }),
      line({ type: "text-delta", text: "lo" }),
      JSON.stringify({ type: "finish", finishReason: "stop" }),
    ]), "cc-model");
    expect(out.status).toBe(200);
    const text = await out.text();
    expect(text.trim().endsWith("[DONE]")).toBe(true);
    const content = text.split("\n\n").filter(e => e.startsWith("data: {")).map(e => JSON.parse(e.slice(6)))
      .map(c => c.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("Hello");
  });

  it("stops inspecting at [DONE]", async () => {
    const out = await inspectAndWrapCommandCodeResponse(ndjsonRes(["data: [DONE]\n", line({ type: "error", error: "late" })]), "m");
    expect(out.status).toBe(200);
  });
});

describe("CommandCodeExecutor.execute", () => {
  it("sends Bearer + stream:true and returns a translated SSE response", async () => {
    fetchMock.mockResolvedValueOnce(ndjsonRes([line({ type: "text-delta", text: "ok" }), line({ type: "finish", finishReason: "stop" })]));
    const out = await new CommandCodeExecutor().execute({ model: "m", body: { messages: [] }, stream: true, credentials: { apiKey: "user_k" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer user_k");
    expect(JSON.parse(init.body).stream).toBe(true);
    expect(await out.response.text()).toContain('"ok"');
  });

  it("non-ok HTTP upstream is returned as-is (no inspection)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const out = await new CommandCodeExecutor().execute({ model: "m", body: {}, stream: true, credentials: { apiKey: "k" } });
    expect(out.response.status).toBe(401);
    expect(await out.response.text()).toBe("nope");
  });

  it("retries a 503 error event then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(ndjsonRes([line({ type: "error", error: { message: "x", statusCode: 503 } })]))
      .mockResolvedValueOnce(ndjsonRes([line({ type: "text-delta", text: "ok" })]));
    const p = new CommandCodeExecutor().execute({ model: "m", body: {}, stream: true, credentials: { apiKey: "k" } });
    await vi.advanceTimersByTimeAsync(1500);
    const out = await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
  });

  it("non-retryable error event (429) is surfaced immediately and does not leak the api key", async () => {
    fetchMock.mockResolvedValueOnce(ndjsonRes([line({ type: "error", error: "rate limit hit" })]));
    const out = await new CommandCodeExecutor().execute({ model: "m", body: {}, stream: true, credentials: { apiKey: "user_SECRET" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.response.status).toBe(429);
    expect(await out.response.text()).not.toContain("user_SECRET");
  });
});
