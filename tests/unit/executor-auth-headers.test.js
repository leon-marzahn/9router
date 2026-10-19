// Auth header / URL / body building for small executors with custom auth:
// Azure (api-key header), Gemini CLI (Cloud Code Assist envelope), iFlow (HMAC signature).
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import crypto from "node:crypto";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { AzureExecutor } = await import("../../open-sse/executors/azure.js");
const { GeminiCLIExecutor } = await import("../../open-sse/executors/gemini-cli.js");
const { IFlowExecutor } = await import("../../open-sse/executors/iflow.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");

beforeEach(() => fetchMock.mockReset());

describe("AzureExecutor", () => {
  const envKeys = ["AZURE_ENDPOINT", "AZURE_API_VERSION", "AZURE_DEPLOYMENT", "OPENAI_API_KEY", "AZURE_ORGANIZATION"];
  const saved = {};
  beforeEach(() => { for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("builds the deployment URL from providerSpecificData, trimming trailing slash", () => {
    const url = new AzureExecutor().buildUrl("gpt-4o", true, 0, {
      providerSpecificData: { azureEndpoint: "https://res.openai.azure.com/", apiVersion: "2025-01-01", deployment: "dep1" },
    });
    expect(url).toBe("https://res.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2025-01-01");
  });

  it("falls back to model as deployment and default api version", () => {
    const url = new AzureExecutor().buildUrl("gpt-4o", true, 0, { providerSpecificData: { azureEndpoint: "https://r" } });
    expect(url).toBe("https://r/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-01-preview");
  });

  it("uses api-key header (never Authorization) and OpenAI-Organization", () => {
    const h = new AzureExecutor().buildHeaders({ apiKey: "az", providerSpecificData: { organization: "org" } }, true);
    expect(h["api-key"]).toBe("az");
    expect(h.Authorization).toBeUndefined();
    expect(h["OpenAI-Organization"]).toBe("org");
    expect(h.Accept).toBe("text/event-stream");
  });

  it("omits api-key when no credential is available and passes body through", () => {
    const ex = new AzureExecutor();
    const h = ex.buildHeaders({}, false);
    expect(h["api-key"]).toBeUndefined();
    expect(h.Accept).toBeUndefined();
    const body = { messages: [] };
    expect(ex.transformRequest("m", body)).toBe(body);
  });
});

describe("GeminiCLIExecutor", () => {
  it("builds :streamGenerateContent vs :generateContent URLs", () => {
    const ex = new GeminiCLIExecutor();
    expect(ex.buildUrl("m", true)).toBe(`${PROVIDERS["gemini-cli"].baseUrl}:streamGenerateContent?alt=sse`);
    expect(ex.buildUrl("m", false)).toBe(`${PROVIDERS["gemini-cli"].baseUrl}:generateContent`);
  });

  it("wraps the body in a {project, model, request} envelope; leaves pre-wrapped bodies alone", () => {
    const ex = new GeminiCLIExecutor();
    const body = { contents: [] };
    expect(ex.transformRequest("gemini-2.5-pro", body, true, { projectId: "p1" })).toEqual({ project: "p1", model: "gemini-2.5-pro", request: body });
    const wrapped = { model: "x", request: {} };
    expect(ex.transformRequest("y", wrapped, true, {})).toBe(wrapped);
  });

  it("sends Bearer access token and Accept per stream mode", () => {
    const ex = new GeminiCLIExecutor();
    ex.transformRequest("gemini-2.5-pro", {}, true, {});
    const h = ex.buildHeaders({ accessToken: "ya29" }, true);
    expect(h.Authorization).toBe("Bearer ya29");
    expect(h.Accept).toBe("text/event-stream");
    expect(h["User-Agent"]).toBeTruthy();
    expect(ex.buildHeaders({ accessToken: "ya29" }, false).Accept).toBe("application/json");
  });

  it("parseError surfaces RetryInfo.retryDelay on 429 only", () => {
    const ex = new GeminiCLIExecutor();
    const body = JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } });
    expect(ex.parseError({ status: 429 }, body).retryAfter).toBe("12s");
    expect(ex.parseError({ status: 500 }, body).retryAfter).toBeUndefined();
    expect(ex.parseError({ status: 429 }, "not json")).toEqual({ status: 429, message: "not json" });
    expect(ex.parseError({ status: 429 }, "").message).toBe("HTTP 429");
  });

  describe("refreshCredentials (global fetch)", () => {
    let spy;
    beforeEach(() => { spy = vi.spyOn(globalThis, "fetch"); });
    afterEach(() => spy.mockRestore());

    it("returns null without refresh token", async () => {
      expect(await new GeminiCLIExecutor().refreshCredentials({})).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it("refreshes and preserves projectId / refresh token", async () => {
      spy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new", expires_in: 3599 }), { status: 200 }));
      const out = await new GeminiCLIExecutor().refreshCredentials({ refreshToken: "r", projectId: "p" });
      expect(out).toEqual({ accessToken: "new", refreshToken: "r", expiresIn: 3599, projectId: "p" });
      const params = Object.fromEntries(spy.mock.calls[0][1].body);
      expect(params.grant_type).toBe("refresh_token");
      expect(params.refresh_token).toBe("r");
    });

    it("returns null on HTTP error and on network error without logging the token", async () => {
      spy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
      expect(await new GeminiCLIExecutor().refreshCredentials({ refreshToken: "r" })).toBeNull();
      spy.mockImplementationOnce(async () => { throw new Error("offline"); });
      const log = { error: vi.fn(), info: vi.fn() };
      expect(await new GeminiCLIExecutor().refreshCredentials({ refreshToken: "secret-refresh" }, log)).toBeNull();
      expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-refresh");
    });
  });
});

describe("IFlowExecutor", () => {
  it("signs user-agent:session:timestamp with HMAC-SHA256 keyed by the api key", () => {
    const ex = new IFlowExecutor();
    const h = ex.buildHeaders({ apiKey: "ifk" }, true);
    const ua = PROVIDERS.iflow.headers?.["User-Agent"] || "iFlow-Cli";
    const expected = crypto.createHmac("sha256", "ifk").update(`${ua}:${h["session-id"]}:${h["x-iflow-timestamp"]}`).digest("hex");
    expect(h["x-iflow-signature"]).toBe(expected);
    expect(h["session-id"]).toMatch(/^session-[0-9a-f-]{36}$/);
    expect(h.Authorization).toBe("Bearer ifk");
    expect(h.Accept).toBe("text/event-stream");
  });

  it("empty signature and no Authorization without credentials; OAuth token signs but is not sent as Bearer", () => {
    const ex = new IFlowExecutor();
    const none = ex.buildHeaders({}, false);
    expect(none["x-iflow-signature"]).toBe("");
    expect(none.Authorization).toBeUndefined();
    const oauth = ex.buildHeaders({ accessToken: "tok" }, false);
    expect(oauth["x-iflow-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(oauth.Authorization).toBeUndefined();
  });

  it("signature never contains the raw key", () => {
    const h = new IFlowExecutor().buildHeaders({ apiKey: "raw-key-value" }, false);
    expect(JSON.stringify({ ...h, Authorization: undefined })).not.toContain("raw-key-value");
  });

  it("injects stream_options.include_usage only for streaming requests without one", () => {
    const ex = new IFlowExecutor();
    expect(ex.transformRequest("m", { messages: [] }, true).stream_options).toEqual({ include_usage: true });
    expect(ex.transformRequest("m", { messages: [] }, false).stream_options).toBeUndefined();
    expect(ex.transformRequest("m", { messages: [], stream_options: { x: 1 } }, true).stream_options).toEqual({ x: 1 });
    expect(ex.buildUrl("m", true)).toBe(PROVIDERS.iflow.baseUrl);
  });
});
