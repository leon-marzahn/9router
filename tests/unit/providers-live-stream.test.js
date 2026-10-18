import { describe, it, expect, vi, afterEach } from "vitest";
import { emitLive } from "@/lib/liveEvents.js";
import { GET } from "@/app/api/providers/stream/route.js";

const decoder = new TextDecoder();

async function readUntil(reader, needle) {
  let buf = "";
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  return buf;
}

function open() {
  const ctrl = new AbortController();
  const req = new Request("http://localhost/api/providers/stream", { signal: ctrl.signal });
  return { ctrl, resPromise: GET(req) };
}

describe("providers live stream", () => {
  afterEach(() => vi.useRealTimers());

  it("signals a change, coalescing bursts into one event with no payload data", async () => {
    vi.useFakeTimers();
    const { ctrl, resPromise } = open();
    const res = await resPromise;
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body.getReader();
    await readUntil(reader, "retry:");

    emitLive("providers");
    emitLive("providers");
    emitLive("providers");
    await vi.advanceTimersByTimeAsync(500);

    const chunk = await readUntil(reader, "\n\n");
    expect(chunk.match(/event: providers/g)).toHaveLength(1);
    expect(chunk).toMatch(/^event: providers\ndata: \d+\n\n$/);
    ctrl.abort();
  });

  it("caps concurrent streams and frees slots on disconnect", async () => {
    const opened = [];
    for (let i = 0; i < 16; i++) {
      const s = open();
      await s.resPromise;
      opened.push(s);
    }
    const over = await open().resPromise;
    expect(over.status).toBe(429);

    opened.forEach((s) => s.ctrl.abort());
    const again = open();
    expect((await again.resPromise).status).toBe(200);
    again.ctrl.abort();
  });
});
