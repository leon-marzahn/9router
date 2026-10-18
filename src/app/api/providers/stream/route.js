import { onLive } from "@/lib/liveEvents";

export const dynamic = "force-dynamic";

// Server-sent "providers changed" signals for the dashboard. Lives under
// /api/providers so dashboardGuard's auth applies. Payload is a timestamp only;
// the client refetches /api/providers (which strips credentials).
const MAX_STREAMS = 16;
const COALESCE_MS = 400;
const KEEPALIVE_MS = 25_000;
const KEY = Symbol.for("9router.providerStreams");
const open = (globalThis[KEY] ??= { count: 0 });

export async function GET(request) {
  if (open.count >= MAX_STREAMS) {
    return new Response("Too many live streams", { status: 429 });
  }
  open.count += 1;

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let timer = null;
      let closed = false;
      const write = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      // Many DB writes can land at once (a test batch, a request burst):
      // send at most one signal per COALESCE_MS.
      const off = onLive("providers", () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          write(`event: providers\ndata: ${Date.now()}\n\n`);
        }, COALESCE_MS);
      });
      const keepalive = setInterval(() => write(`: ping\n\n`), KEEPALIVE_MS);

      cleanup = () => {
        if (closed) return;
        closed = true;
        off();
        clearInterval(keepalive);
        clearTimeout(timer);
        open.count -= 1;
        try { controller.close(); } catch {}
      };
      request.signal.addEventListener("abort", cleanup);
      write(`retry: 3000\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
