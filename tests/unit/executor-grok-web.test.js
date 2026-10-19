// Grok Web executor: cookie auth, payload building, NDJSON stream parsing
// (split chunks, malformed lines, upstream error events) and HTTP error mapping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

const { GrokWebExecutor } = await import("../../open-sse/executors/grok-web.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");

let fetchSpy;
let fetchQueue;
beforeEach(() => {
  fetchQueue = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = fetchQueue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
});
afterEach(() => fetchSpy.mockRestore());

function ndjson(chunks) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  }), { status: 200 });
}
const tok = (t) => JSON.stringify({ result: { response: { token: t, responseId: "r1" } } }) + "\n";
const user = (content) => ({ messages: [{ role: "user", content }] });

describe("GrokWebExecutor request building", () => {
  it("rejects missing / empty messages with 400 without calling upstream", async () => {
    const ex = new GrokWebExecutor();
    const a = await ex.execute({ model: "grok-4", body: {}, stream: false, credentials: {} });
    expect(a.response.status).toBe(400);
    const b = await ex.execute({ model: "grok-4", body: { messages: [{ role: "user", content: "   " }] }, stream: false, credentials: {} });
    expect(b.response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends sso cookie (stripping a pasted sso= prefix) and flattens history into one message", async () => {
    fetchQueue.push(ndjson([tok("ok")]));
    const out = await new GrokWebExecutor().execute({
      model: "grok-4",
      body: { messages: [
        { role: "developer", content: "be nice" },
        { role: "assistant", content: [{ type: "text", text: "prev" }, { type: "image_url" }] },
        { role: "user", content: "question" },
      ] },
      stream: false,
      credentials: { apiKey: "sso=COOKIE" },
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(PROVIDERS["grok-web"].baseUrl);
    expect(init.headers.Cookie).toBe("sso=COOKIE");
    const payload = JSON.parse(init.body);
    expect(payload.message).toBe("system: be nice\n\nassistant: prev\n\nquestion");
    expect(payload.modelName).toBe("grok-4");
    expect(payload.modelMode).toBe("MODEL_MODE_GROK_4");
    expect(out.transformedBody).toEqual(payload);
  });

  it("maps unknown models to grok-4.1-fast", async () => {
    fetchQueue.push(ndjson([tok("x")]));
    const log = { info: vi.fn() };
    await new GrokWebExecutor().execute({ model: "nope", body: user("q"), stream: false, credentials: { apiKey: "c" }, log });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).modelMode).toBe("MODEL_MODE_FAST");
  });
});

describe("GrokWebExecutor error mapping", () => {
  it.each([
    [401, /SSO cookie may be expired/],
    [403, /SSO cookie may be expired/],
    [429, /rate limited/],
    [500, /HTTP 500/],
  ])("HTTP %i → mapped error with same status", async (status, re) => {
    fetchQueue.push(new Response("upstream body with secret", { status }));
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: { apiKey: "c" } });
    expect(out.response.status).toBe(status);
    const j = await out.response.json();
    expect(j.error.message).toMatch(re);
    expect(j.error.code).toBe(`HTTP_${status}`);
  });

  it("network failure → 502 without leaking the cookie", async () => {
    fetchQueue.push(new Error("ENOTFOUND"));
    const log = { info: vi.fn(), error: vi.fn() };
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: { apiKey: "SECRETCOOKIE" }, log });
    expect(out.response.status).toBe(502);
    const text = await out.response.text();
    expect(text).toContain("ENOTFOUND");
    expect(text).not.toContain("SECRETCOOKIE");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("SECRETCOOKIE");
  });

  it("empty upstream body → 502", async () => {
    fetchQueue.push(new Response(null, { status: 200 }));
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: {} });
    expect(out.response.status).toBe(502);
  });
});

describe("GrokWebExecutor NDJSON parsing", () => {
  it("non-stream: joins tokens across split chunks, skips malformed lines, parses trailing line w/o newline", async () => {
    const line1 = tok("Hel");
    fetchQueue.push(ndjson([
      line1.slice(0, 10), line1.slice(10),
      "{not json}\n",
      "\n",
      JSON.stringify({ result: { response: { llmInfo: { modelHash: "fp1" } } } }) + "\n",
      JSON.stringify({ result: { response: { token: "lo" } } }),
    ]));
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: {} });
    const j = await out.response.json();
    expect(j.choices[0].message.content).toBe("Hello");
    expect(j.system_fingerprint).toBe("fp1");
    expect(j.object).toBe("chat.completion");
    expect(j.usage.total_tokens).toBeGreaterThan(0);
  });

  it("non-stream: modelResponse.message replaces accumulated tokens", async () => {
    fetchQueue.push(ndjson([tok("partial"), JSON.stringify({ result: { response: { modelResponse: { message: "Final answer" } } } }) + "\n"]));
    const j = await (await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: {} })).response.json();
    expect(j.choices[0].message.content).toBe("Final answer");
  });

  it("non-stream: upstream error event → 502 GROK_ERROR", async () => {
    fetchQueue.push(ndjson([tok("a"), JSON.stringify({ error: { code: 7, message: "denied" } }) + "\n"]));
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: false, credentials: {} });
    expect(out.response.status).toBe(502);
    expect((await out.response.json()).error).toMatchObject({ message: "denied", code: "GROK_ERROR" });
  });

  it("stream: emits role chunk, content deltas, stop and [DONE]", async () => {
    fetchQueue.push(ndjson([tok("A"), tok("B")]));
    const out = await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: true, credentials: {} });
    expect(out.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await out.response.text();
    const events = text.split("\n\n").filter(Boolean);
    expect(events.at(-1).trim()).toBe("data: [DONE]");
    const datas = events.slice(0, -1).map(e => JSON.parse(e.replace(/^data: /, "")));
    expect(datas[0].choices[0].delta.role).toBe("assistant");
    expect(datas.map(d => d.choices[0].delta.content).filter(Boolean).join("")).toBe("AB");
    expect(datas.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("stream: error event becomes an inline [Error: …] chunk then terminates cleanly", async () => {
    fetchQueue.push(ndjson([JSON.stringify({ error: { code: 3 } }) + "\n"]));
    const text = await (await new GrokWebExecutor().execute({ model: "grok-4", body: user("q"), stream: true, credentials: {} })).response.text();
    expect(text).toContain("[Error: Grok error: 3]");
    expect(text).toContain("[DONE]");
  });

  // BUG: extractContent() never sets `thinkOpened = true`, so the
  // `{ thinking }` branch is dead and thinking models (grok-4-thinking, grok-3-mini,
  // ...) never surface reasoning_content.
  it.skip("stream: thinking models surface reasoning_content (BUG: thinkOpened never set)", async () => {
    fetchQueue.push(ndjson([tok("think"), JSON.stringify({ result: { response: { modelResponse: { message: "answer" } } } }) + "\n"]));
    const text = await (await new GrokWebExecutor().execute({ model: "grok-4-thinking", body: user("q"), stream: true, credentials: {} })).response.text();
    expect(text).toContain("reasoning_content");
  });
});
