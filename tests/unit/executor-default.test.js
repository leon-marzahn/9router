// Behavior tests for DefaultExecutor (open-sse/executors/default.js): URL building,
// auth-header descriptors, request transforms and OAuth refresh grants. Network mocked.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (...args) => {
    const r = await fetchMock(...args);
    if (r instanceof Error) throw r;
    return r;
  },
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
const { ANTHROPIC_API_VERSION } = await import("../../open-sse/providers/shared.js");

const SECRET = "sk-secret-DO-NOT-LEAK-123";

function jsonRes(status, data) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => fetchMock.mockReset());

describe("DefaultExecutor.buildUrl", () => {
  it("uses the registry baseUrl for a plain OpenAI-format provider", () => {
    expect(new DefaultExecutor("openai").buildUrl("gpt-4o", true)).toBe(PROVIDERS.openai.baseUrl);
  });

  it("falls back to the openai config for unknown providers", () => {
    expect(new DefaultExecutor("no-such-provider").buildUrl("m", true)).toBe(PROVIDERS.openai.baseUrl);
  });

  it("appends the registry urlSuffix (claude ?beta=true)", () => {
    expect(new DefaultExecutor("claude").buildUrl("claude-sonnet-4", true)).toBe(`${PROVIDERS.claude.baseUrl}?beta=true`);
  });

  it("builds gemini stream vs non-stream paths", () => {
    const ex = new DefaultExecutor("gemini");
    expect(ex.buildUrl("gemini-2.5-pro", true)).toBe(`${PROVIDERS.gemini.baseUrl}/gemini-2.5-pro:streamGenerateContent?alt=sse`);
    expect(ex.buildUrl("gemini-2.5-pro", false)).toBe(`${PROVIDERS.gemini.baseUrl}/gemini-2.5-pro:generateContent`);
  });

  it("substitutes {accountId} and throws without it", () => {
    const ex = new DefaultExecutor("cloudflare-ai");
    const url = ex.buildUrl("m", true, 0, { providerSpecificData: { accountId: "acc123" } });
    expect(url).toContain("/accounts/acc123/");
    expect(url).not.toContain("{accountId}");
    expect(() => ex.buildUrl("m", true, 0, {})).toThrow(/accountId/);
  });

  it("openai-compatible: strips trailing slash and picks chat/completions vs responses", () => {
    const ex = new DefaultExecutor("openai-compatible-x");
    expect(ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://gw.example/v1/" } }))
      .toBe("https://gw.example/v1/chat/completions");
    expect(ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://gw.example/v1", apiType: "responses" } }))
      .toMatch(/\/(responses|chat\/completions)$/);
  });

  it("anthropic-compatible: appends /messages", () => {
    const ex = new DefaultExecutor("anthropic-compatible-x");
    expect(ex.buildUrl("m", true, 0, { providerSpecificData: { baseUrl: "https://a.example/v1/" } }))
      .toBe("https://a.example/v1/messages");
  });

  it("runtimeTransport overrides everything", () => {
    const ex = new DefaultExecutor("openai");
    expect(ex.buildUrl("m", true, 0, { runtimeTransport: { baseUrl: "https://rt.example", urlSuffix: "/x" } })).toBe("https://rt.example/x");
    expect(ex.buildUrl("m", true, 0, { runtimeTransport: { baseUrl: "https://rt.example" } })).toBe("https://rt.example");
  });
});

describe("DefaultExecutor.buildHeaders — auth", () => {
  it("bearer for openai with apiKey; Accept only when streaming", () => {
    const ex = new DefaultExecutor("openai");
    const h = ex.buildHeaders({ apiKey: "k1" }, true);
    expect(h.Authorization).toBe("Bearer k1");
    expect(h.Accept).toBe("text/event-stream");
    expect(ex.buildHeaders({ apiKey: "k1" }, false).Accept).toBeUndefined();
  });

  it("claude: apiKey → x-api-key (no Authorization); OAuth → Bearer", () => {
    const ex = new DefaultExecutor("claude");
    const h1 = ex.buildHeaders({ apiKey: "ak" }, true, null, "claude-sonnet-4", {});
    expect(h1["x-api-key"]).toBe("ak");
    expect(h1.Authorization).toBeUndefined();
    expect(typeof h1["Anthropic-Beta"]).toBe("string");
    const h2 = ex.buildHeaders({ accessToken: "sk-ant-oat-tok" }, true, null, "claude-sonnet-4", {});
    expect(h2.Authorization).toBe("Bearer sk-ant-oat-tok");
    expect(h2["x-api-key"]).toBeUndefined();
  });

  it("gemini: apiKey → x-goog-api-key", () => {
    const h = new DefaultExecutor("gemini").buildHeaders({ apiKey: "g" }, false);
    expect(h["x-goog-api-key"]).toBe("g");
    expect(h.Authorization).toBeUndefined();
  });

  it("combined x-api-key provider (glm) prefers apiKey and sets anthropic-version only if configured", () => {
    const h = new DefaultExecutor("glm").buildHeaders({ apiKey: "z", accessToken: "t" }, true);
    expect(h["x-api-key"]).toBe("z");
  });

  it("anthropic-compatible on official host: x-api-key + anthropic-version, no Bearer", () => {
    const ex = new DefaultExecutor("anthropic-compatible-x");
    const h = ex.buildHeaders({ apiKey: "ak" }, true, null, "kimi-k2", {});
    expect(h["x-api-key"]).toBe("ak");
    expect(h["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
    expect(h.Authorization).toBeUndefined();
    expect(h["Anthropic-Beta"]).toBeUndefined(); // non-claude model id: no beta flags
  });

  it("anthropic-compatible third-party gateway: adds Bearer and strips first-party identity headers", () => {
    const ex = new DefaultExecutor("anthropic-compatible-x");
    const creds = {
      apiKey: "ak",
      providerSpecificData: { baseUrl: "https://gw.example/v1" },
      rawHeaders: { "anthropic-beta": "claude-code-20250219" },
    };
    const h = ex.buildHeaders(creds, true, null, "claude-sonnet-4", {});
    expect(h.Authorization).toBe("Bearer ak");
    expect(h["x-api-key"]).toBe("ak");
    expect(h["x-app"]).toBeUndefined();
    expect(h["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(h["Anthropic-Beta"] || "").not.toContain("claude-code-20250219");
  });

  it("anthropic-compatible with neither apiKey nor accessToken sets no auth header", () => {
    const h = new DefaultExecutor("anthropic-compatible-x").buildHeaders({}, false);
    expect(h["x-api-key"]).toBeUndefined();
    expect(h.Authorization).toBeUndefined();
  });

  it("hooks run before auth so they cannot clobber the token (kilocode org header)", () => {
    const h = new DefaultExecutor("kilocode").buildHeaders({ apiKey: "kc", providerSpecificData: { orgId: "org9" } }, false);
    expect(h["X-Kilocode-OrganizationID"]).toBe("org9");
    expect(h.Authorization).toBe("Bearer kc");
  });

  it("minimax-code hook adds placeholder x-api-key + session id but keeps real Bearer token", () => {
    const h = new DefaultExecutor("minimax-code").buildHeaders({ apiKey: "real" }, false);
    expect(h.Authorization).toBe("Bearer real");
    expect(h["x-api-key"]).toBe("sk-xxx");
    expect(h["X-Mavis-Session-Id"]).toBeTruthy();
  });

  it("muse hook adds x-api-version only for subscription tokens", () => {
    const ex = new DefaultExecutor("muse");
    expect(ex.buildHeaders({ accessToken: "t" }, false)["x-api-version"]).toBe("1.0.0");
    expect(ex.buildHeaders({ apiKey: "k" }, false)["x-api-version"]).toBeUndefined();
  });

  it("anthropic provider merges client anthropic-beta", () => {
    const h = new DefaultExecutor("anthropic").buildHeaders({ apiKey: "k", rawHeaders: { "anthropic-beta": "foo-2025" } }, false, null, "claude-x", {});
    expect(h["Anthropic-Beta"]).toContain("foo-2025");
  });

  it("runtimeTransport headers/auth replace registry ones", () => {
    const h = new DefaultExecutor("openai").buildHeaders({
      apiKey: "rk",
      runtimeTransport: { baseUrl: "https://rt", headers: { "X-RT": "1" }, auth: { combined: true, header: "x-key", scheme: "raw" } },
    }, false);
    expect(h["X-RT"]).toBe("1");
    expect(h["x-key"]).toBe("rk");
    expect(h.Authorization).toBeUndefined();
  });
});

describe("DefaultExecutor.transformRequest", () => {
  it("openai-compatible: json_schema → json_object with schema prompt injected as system", () => {
    const ex = new DefaultExecutor("openai-compatible-x");
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { schema: { type: "object", properties: { a: { type: "string" } } } } },
    };
    const out = ex.transformRequest("m", body, false, { providerSpecificData: { baseUrl: "https://x.example/v1" } });
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain('"a"');
    expect(body.messages).toHaveLength(1); // input not mutated
  });

  it("appends schema prompt to existing string and array system messages", () => {
    const ex = new DefaultExecutor("openai-compatible-x");
    const rf = { type: "json_schema", json_schema: { schema: { type: "object" } } };
    const s1 = ex.applyJsonSchemaFallback({ messages: [{ role: "system", content: "base" }], response_format: rf });
    expect(s1.messages[0].content.startsWith("base\n\n")).toBe(true);
    const s2 = ex.applyJsonSchemaFallback({ messages: [{ role: "system", content: [{ type: "text", text: "b" }] }], response_format: rf });
    expect(s2.messages[0].content).toHaveLength(2);
  });

  it("does not apply json_schema fallback for first-party providers", () => {
    const body = { messages: [], response_format: { type: "json_schema", json_schema: { schema: {} } } };
    expect(new DefaultExecutor("openai").applyJsonSchemaFallback(body)).toBe(body);
  });

  it("drops client_metadata when the dropClientMetadata quirk is set", () => {
    const out = new DefaultExecutor("cerebras").transformRequest("m", { messages: [], client_metadata: { a: 1 } }, false, {});
    expect(out.client_metadata).toBeUndefined();
  });

  it("Nous attribution tags only for the exact Nous https endpoint, replacing empty values", () => {
    const ex = new DefaultExecutor("openai-compatible-nous");
    const creds = { apiKey: "k", providerSpecificData: { baseUrl: "https://inference-api.nousresearch.com/v1" } };
    const out = ex.applyNousAttribution("m", { messages: [], tags: ["product=", "keep"] }, false, creds);
    expect(out.tags).toContain("keep");
    expect(out.tags).toContain("product=9router");
    expect(out.tags).not.toContain("product=");
    const other = { messages: [] };
    expect(ex.applyNousAttribution("m", other, false, { apiKey: "k", providerSpecificData: { baseUrl: "https://evil.example/v1" } })).toBe(other);
    expect(ex.applyNousAttribution("m", other, false, { providerSpecificData: creds.providerSpecificData })).toBe(other);
    const badTags = { messages: [], tags: "x" };
    expect(ex.applyNousAttribution("m", badTags, false, creds)).toBe(badTags);
  });
});

describe("DefaultExecutor.execute", () => {
  it("POSTs the transformed JSON body with auth headers to the built URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { ok: true }));
    const ex = new DefaultExecutor("openai");
    const out = await ex.execute({ model: "gpt-4o", body: { model: "gpt-4o", messages: [{ role: "user", content: "x" }] }, stream: false, credentials: { apiKey: "k" } });
    expect(out.response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PROVIDERS.openai.baseUrl);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body).messages[0].content).toBe("x");
  });

  it("user providerOverrides.headers win over registry headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));
    await new DefaultExecutor("openai").execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" }, providerOverrides: { headers: { "X-Custom": "y" } } });
    expect(fetchMock.mock.calls[0][1].headers["X-Custom"]).toBe("y");
  });

});

describe("DefaultExecutor.execute — client abort", () => {
  it("propagates a client AbortError without retrying", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockReturnValue(err);
    let caught;
    try {
      await new DefaultExecutor("openai").execute({ model: "m", body: {}, stream: false, credentials: { apiKey: "k" }, signal: new AbortController().signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("DefaultExecutor.refreshCredentials", () => {
  it("returns null without a refresh token or for providers without a refresher", async () => {
    expect(await new DefaultExecutor("claude").refreshCredentials({})).toBeNull();
    expect(await new DefaultExecutor("openai").refreshCredentials({ refreshToken: "r" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("claude: JSON or form refresh grant with refresh_token; keeps old refresh token if none returned", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { access_token: "new", expires_in: 3600 }));
    const out = await new DefaultExecutor("claude").refreshCredentials({ refreshToken: "old-r" });
    expect(out).toEqual({ accessToken: "new", refreshToken: "old-r", expiresIn: 3600 });
    const [, init] = fetchMock.mock.calls[0];
    const sent = typeof init.body === "string" ? JSON.parse(init.body) : Object.fromEntries(init.body);
    expect(sent.grant_type).toBe("refresh_token");
    expect(sent.refresh_token).toBe("old-r");
  });

  it("returns null on a non-ok refresh response", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(400, { error: "invalid_grant" }));
    expect(await new DefaultExecutor("codex").refreshCredentials({ refreshToken: "r" })).toBeNull();
  });

  it("network failure is swallowed, logged without the refresh token", async () => {
    fetchMock.mockReturnValueOnce(new Error("ECONNRESET"));
    const log = { error: vi.fn(), info: vi.fn() };
    expect(await new DefaultExecutor("codex").refreshCredentials({ refreshToken: SECRET }, log)).toBeNull();
    expect(log.error).toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(SECRET);
  });

  it("iflow: Basic auth form refresh", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { access_token: "a", refresh_token: "b", expires_in: 1 }));
    const out = await new DefaultExecutor("iflow").refreshCredentials({ refreshToken: "r" });
    expect(out).toEqual({ accessToken: "a", refreshToken: "b", expiresIn: 1 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
  });

  it("kiro: JSON body with refreshToken, camelCase response", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { accessToken: "ka", expiresIn: 5 }));
    const out = await new DefaultExecutor("kiro").refreshCredentials({ refreshToken: "kr" });
    expect(out).toEqual({ accessToken: "ka", refreshToken: "kr", expiresIn: 5 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refreshToken: "kr" });
  });

  it("cline: prefixes workos: and derives expiresIn from expiresAt", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    fetchMock.mockResolvedValueOnce(jsonRes(200, { data: { accessToken: "tok", refreshToken: "nr", expiresAt } }));
    const out = await new DefaultExecutor("cline").refreshCredentials({ refreshToken: "r" });
    expect(out.accessToken).toBe("workos:tok");
    expect(out.refreshToken).toBe("nr");
    expect(out.expiresIn).toBeGreaterThan(100);
    expect(out.expiresIn).toBeLessThanOrEqual(120);
    fetchMock.mockResolvedValueOnce(jsonRes(200, { accessToken: "workos:already" }));
    expect((await new DefaultExecutor("clinepass").refreshCredentials({ refreshToken: "r" })).accessToken).toBe("workos:already");
  });

  it("kimi: form refresh with X-Msh device headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { access_token: "ka" }));
    const out = await new DefaultExecutor("kimi").refreshCredentials({ refreshToken: "r", providerSpecificData: { deviceId: "dev1" } });
    if (out) {
      expect(out.accessToken).toBe("ka");
      expect(Object.fromEntries(fetchMock.mock.calls[0][1].body).grant_type).toBe("refresh_token");
    }
  });

  it("gemini OAuth refresh sends a refresh_token grant with Google client credentials", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { access_token: "g" }));
    const out = await new DefaultExecutor("gemini").refreshCredentials({ refreshToken: "r" });
    expect(out?.accessToken).toBe("g");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = Object.fromEntries(init.body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("r");
    expect(body.client_id).toMatch(/apps\.googleusercontent\.com$/);
    expect(body.client_secret).toBeTruthy();
  });

  it("kilocode has no refresh support", async () => {
    expect(await new DefaultExecutor("kilocode").refreshCredentials({ refreshToken: "r" })).toBeNull();
  });
});
