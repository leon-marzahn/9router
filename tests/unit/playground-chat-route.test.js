// POST /api/dashboard/chat/completions (src/lib/playground): session-only auth (API keys
// never count), same-origin + JSON only, whitelisted body, data:-only images, configured
// models only, rate/concurrency limits, redacted errors, and a fresh request handed to
// handleChat carrying only the picked key (resolved server-side, never echoed).
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const KEY_SECRET = vi.hoisted(() => "sk-pg-secret-1234567890abcdef");
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireLogin: true })) }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-session" || t === "other-session"),
}));
vi.mock("@/dashboardGuard.js", () => ({ isLocalRequest: vi.fn(() => false) }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: vi.fn(async ({ provider }) =>
    provider === "openai" ? [{ id: "c1" }] : [],
  ),
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: vi.fn(async (m) => (m === "my-combo" ? ["openai/gpt-4o"] : null)),
  getModelInfo: vi.fn(async (m) => {
    const i = m.indexOf("/");
    return i < 0
      ? { provider: null, model: m }
      : { provider: m.slice(0, i), model: m.slice(i + 1) };
  }),
  stripComboPrefix: (m) => (m.startsWith("combo/") ? m.slice(6) : m),
}));
vi.mock("@/lib/playground/keys.js", () => ({
  resolvePlaygroundKey: vi.fn(
    async (id) =>
      ({
        "key-1": { id: "key-1", name: "Team", key: KEY_SECRET, isActive: true },
        "key-off": { id: "key-off", name: "Old", key: "sk-off-secret-0000", isActive: false },
      })[id] ?? null,
  ),
}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));

import { handleChat } from "@/sse/handlers/chat.js";
import { getSettings } from "@/lib/localDb";
import { isLocalRequest } from "@/dashboardGuard.js";
import { POST } from "@/app/api/dashboard/chat/completions/route.js";
import * as routeModule from "@/app/api/dashboard/chat/completions/route.js";
import {
  resetPlaygroundLimits,
  RATE_LIMIT_PER_MIN,
  MAX_CONCURRENT,
} from "@/lib/playground/limits.js";
import {
  MAX_BODY_BYTES,
  MAX_OUTPUT_TOKENS,
  validatePlaygroundBody,
} from "@/lib/playground/validate.js";
import { redactErrorMessage } from "@/lib/playground/handler.js";

const HOST = "localhost:20137";
const URL_ = `http://${HOST}/api/dashboard/chat/completions`;
const body = (extra = {}) => ({
  model: "openai/gpt-4o",
  keyId: "key-1",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

function req(payload = body(), { cookie = "auth_token=valid-session", headers = {} } = {}) {
  const h = {
    host: HOST,
    origin: `http://${HOST}`,
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
    ...headers,
  };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  return new Request(URL_, {
    method: "POST",
    headers: h,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}
const sse = () =>
  new Response('data: {"choices":[{"delta":{"content":"hey"}}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetPlaygroundLimits();
  getSettings.mockResolvedValue({ requireLogin: true });
  isLocalRequest.mockReturnValue(false);
  handleChat.mockImplementation(async () =>
    Response.json({ choices: [{ message: { content: "ok" } }] }),
  );
});

describe("auth", () => {
  it("refuses a request without a session (401)", async () => {
    const res = await POST(req(body(), { cookie: null }));
    expect(res.status).toBe(401);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("refuses an API key alone, in any header (401)", async () => {
    const res = await POST(
      req(body(), {
        cookie: null,
        headers: {
          authorization: "Bearer sk-live",
          "x-api-key": "sk-live",
          "x-goog-api-key": "sk-live",
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("refuses an invalid session cookie (401)", async () => {
    expect((await POST(req(body(), { cookie: "auth_token=forged" }))).status).toBe(401);
  });

  it("with requireLogin off, allows local requests only", async () => {
    getSettings.mockResolvedValue({ requireLogin: false });
    expect((await POST(req(body(), { cookie: null }))).status).toBe(401);
    isLocalRequest.mockReturnValue(true);
    expect((await POST(req(body(), { cookie: null }))).status).toBe(200);
  });
});

describe("CSRF / same-origin", () => {
  it("refuses a cross-origin Origin (403)", async () => {
    const res = await POST(req(body(), { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("refuses another port on the same host (same-site, cross-origin)", async () => {
    expect((await POST(req(body(), { headers: { origin: "http://localhost:3000" } }))).status).toBe(
      403,
    );
  });

  it("without Origin, needs Sec-Fetch-Site: same-origin", async () => {
    expect((await POST(req(body(), { headers: { origin: null } }))).status).toBe(403);
    expect(
      (await POST(req(body(), { headers: { origin: null, "sec-fetch-site": "cross-site" } })))
        .status,
    ).toBe(403);
    expect(
      (await POST(req(body(), { headers: { origin: null, "sec-fetch-site": "same-origin" } })))
        .status,
    ).toBe(200);
  });

  it("refuses a non-JSON content type (415)", async () => {
    expect((await POST(req("model=x", { headers: { "content-type": "text/plain" } }))).status).toBe(
      415,
    );
    expect(
      (
        await POST(
          req("model=x", { headers: { "content-type": "application/x-www-form-urlencoded" } }),
        )
      ).status,
    ).toBe(415);
  });

  it("exports no OPTIONS handler and sends no CORS headers", async () => {
    expect(routeModule.OPTIONS).toBeUndefined();
    handleChat.mockImplementationOnce(async () => sse());
    const res = await POST(req(body({ stream: true })));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});

describe("body validation (not an open proxy)", () => {
  it("rejects unknown fields such as base URLs, headers or keys", async () => {
    for (const extra of [
      { baseUrl: "http://169.254.169.254" },
      { headers: { a: "b" } },
      { api_key: "x" },
      { principal: "dashboard" },
      { n: 5 },
    ]) {
      const res = await POST(req(body(extra)));
      expect(res.status).toBe(400);
    }
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("rejects non-data image URLs", async () => {
    const msg = (url) => [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    for (const url of [
      "https://example.com/a.png",
      "file:///etc/passwd",
      "data:text/html;base64,PGI+",
      "http://127.0.0.1/x",
    ]) {
      expect((await POST(req(body({ messages: msg(url) })))).status).toBe(400);
    }
    expect(
      (await POST(req(body({ messages: msg("data:image/png;base64,iVBORw0KGgo=") })))).status,
    ).toBe(200);
  });

  it("validates message shape", () => {
    const bad = [
      [],
      [{ role: "tool", content: "x" }],
      [{ role: "user" }],
      [{ role: "user", content: "x", tool_calls: [] }],
      [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
      [{ role: "user", content: [{ type: "file", file: {} }] }],
      [{ role: "user", content: [{ type: "text", text: 1 }] }],
      "hi",
    ];
    for (const messages of bad)
      expect(validatePlaygroundBody(body({ messages })).error).toBeTruthy();
    expect(
      validatePlaygroundBody(
        body({
          messages: [
            { role: "system", content: "s" },
            { role: "user", content: "u" },
            { role: "assistant", content: "" },
          ],
        }),
      ).body,
    ).toBeTruthy();
  });

  it("checks sampling params and the max_tokens ceiling", () => {
    expect(
      validatePlaygroundBody(body({ temperature: 0.5, top_p: 1, max_tokens: 100, stop: ["x"] }))
        .body,
    ).toMatchObject({ temperature: 0.5, max_tokens: 100 });
    expect(validatePlaygroundBody(body({ max_tokens: MAX_OUTPUT_TOKENS + 1 })).error).toMatch(
      /max_tokens/,
    );
    expect(validatePlaygroundBody(body({ temperature: 9 })).error).toMatch(/temperature/);
    expect(validatePlaygroundBody(body({ stream: "yes" })).error).toMatch(/stream/);
    expect(validatePlaygroundBody(body({ model: "a b" })).error).toMatch(/model/);
    expect(validatePlaygroundBody(null).error).toBeTruthy();
  });

  it("rejects invalid JSON (400) and oversized bodies (413)", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
    expect(
      (await POST(req(body(), { headers: { "content-length": String(MAX_BODY_BYTES + 1) } })))
        .status,
    ).toBe(413);
    const huge = JSON.stringify(
      body({ messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }] }),
    );
    expect((await POST(req(huge))).status).toBe(413);
  });

  it("only accepts models with a configured connection or combo (404 otherwise)", async () => {
    expect((await POST(req(body({ model: "anthropic/claude-x" })))).status).toBe(404);
    expect((await POST(req(body({ model: "combo/nope" })))).status).toBe(404);
    expect((await POST(req(body({ model: "unknown-alias" })))).status).toBe(404);
    expect((await POST(req(body({ model: "my-combo" })))).status).toBe(200);
    expect((await POST(req(body({ model: "combo/my-combo" })))).status).toBe(200);
  });
});

describe("engine hand-off", () => {
  it("sends as the picked key, server-side, in a fresh request without client headers", async () => {
    const res = await POST(
      req(body({ stream: false, temperature: 0.2 }), {
        headers: {
          "sec-fetch-site": "same-origin",
          "x-regent-pipeline": "p1",
          "user-agent": "claude-cli/1.0",
          authorization: "Bearer sk-client-supplied",
          "x-api-key": "sk-client-supplied",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(handleChat).toHaveBeenCalledTimes(1);
    const [internal, ...rest] = handleChat.mock.calls[0];
    expect(rest).toEqual([]); // no engine bypass: a plain keyed request
    expect(internal.headers.get("authorization")).toBe(`Bearer ${KEY_SECRET}`);
    expect(internal.headers.get("x-api-key")).toBeNull();
    expect(await res.clone().text()).not.toContain(KEY_SECRET);
    expect(new URL(internal.url).pathname).toBe("/api/dashboard/chat/completions");
    expect([...internal.headers.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      "accept",
      "authorization",
      "content-type",
      "user-agent",
    ]);
    expect(internal.headers.get("user-agent")).toBe("regent-playground");
    expect(await internal.json()).toEqual({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      temperature: 0.2,
    });
  });

  it("needs a keyId; unknown ids are 404 and disabled keys 403", async () => {
    const { keyId, ...noKey } = body();
    expect((await POST(req(noKey))).status).toBe(400);
    expect((await POST(req(body({ keyId: "../x" })))).status).toBe(400);
    expect((await POST(req(body({ keyId: "nope" })))).status).toBe(404);
    const off = await POST(req(body({ keyId: "key-off" })));
    expect(off.status).toBe(403);
    expect(await off.text()).not.toContain("sk-off-secret");
    expect(handleChat).not.toHaveBeenCalled();
  });

  it("strips the key secret from engine errors by value", async () => {
    handleChat.mockImplementationOnce(async () =>
      Response.json({ error: { message: `bad key ${KEY_SECRET} rejected` } }, { status: 401 }),
    );
    const res = await POST(req());
    expect(await res.text()).not.toContain(KEY_SECRET);
  });

  it("redacts error bodies and drops upstream URLs", async () => {
    handleChat.mockImplementationOnce(async () =>
      Response.json(
        {
          error: {
            message:
              "upstream https://api.secret-host.example/v1 said: invalid api_key=sk-abcdefghijklmnop",
          },
        },
        { status: 401, headers: { "access-control-allow-origin": "*" } },
      ),
    );
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("secret-host");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(redactErrorMessage(null)).toBe("Request failed");
  });

  it("turns a thrown engine error into a redacted 500", async () => {
    handleChat.mockImplementationOnce(async () => {
      throw new Error("boom Bearer abcdefghijklmnop");
    });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("abcdefghijklmnop");
  });
});

describe("abuse limits", () => {
  it("rate-limits per session with a clear 429", async () => {
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      const ok = await POST(req());
      expect(ok.status).toBe(200);
      await ok.text(); // a finished body frees its concurrency slot
    }
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect((await res.json()).error.message).toMatch(/rate limit/i);
  });

  it("rate-limits per client IP across sessions", async () => {
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) await (await POST(req())).text();
    expect((await POST(req(body(), { cookie: "auth_token=other-session" }))).status).toBe(429);
  });

  it("caps concurrent streams and frees the slot when the stream ends", async () => {
    handleChat.mockImplementation(async () => sse());
    const open = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) open.push(await POST(req(body({ stream: true }))));
    const blocked = await POST(req(body({ stream: true })));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error.message).toMatch(/in flight/);
    expect(await open[0].text()).toContain("[DONE]");
    await open[1].body.cancel();
    expect((await POST(req(body({ stream: true })))).status).toBe(200);
  });
});
