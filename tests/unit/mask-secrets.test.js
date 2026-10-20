// Request logs, MITM dumps and debug output must never contain usable credentials.
import { describe, it, expect } from "vite-plus/test";
import { REDACTED, isSecretHeader, maskHeaders, maskString, maskBody } from "../../open-sse/utils/maskSecrets.cjs";

const KEY = "sk-live-abcdef0123456789";

describe("maskHeaders", () => {
  it("redacts the named credential headers case-insensitively", () => {
    const out = maskHeaders({
      Authorization: `Bearer ${KEY}`,
      "Proxy-Authorization": `Basic ${KEY}`,
      "X-API-Key": KEY,
      "x-goog-api-key": KEY,
      "api-key": KEY,
      Cookie: `sid=${KEY}`,
      "Set-Cookie": [`a=${KEY}`, `b=${KEY}`],
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.Authorization).toBe(`Bearer ${REDACTED}`);
    expect(out["Proxy-Authorization"]).toBe(`Basic ${REDACTED}`);
    expect(out["X-API-Key"]).toBe(REDACTED);
    expect(out["Set-Cookie"]).toEqual([REDACTED, REDACTED]);
  });

  it("redacts other token/secret/key/session headers but keeps useful ones", () => {
    for (const h of ["x-access-token", "x-client-secret", "x-session-id", "x-amz-security-token", "x-custom-key", "anthropic-api-key", "x-auth"]) {
      expect(isSecretHeader(h), h).toBe(true);
    }
    for (const h of ["content-type", "user-agent", "anthropic-version", "x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-limit", "keep-alive", "x-request-id", "accept"]) {
      expect(isSecretHeader(h), h).toBe(false);
    }
  });

  it("accepts Headers instances, entry arrays and empty input", () => {
    const out = maskHeaders(new Headers({ authorization: `Bearer ${KEY}`, "content-type": "application/json" }));
    expect(out).toEqual({ authorization: `Bearer ${REDACTED}`, "content-type": "application/json" });
    expect(maskHeaders([["x-api-key", KEY]])).toEqual({ "x-api-key": REDACTED });
    expect(maskHeaders(null)).toEqual({});
    expect(maskHeaders({ "x-api-key": "" })).toEqual({ "x-api-key": "" });
  });
});

describe("maskString", () => {
  it("redacts credential query params in URLs", () => {
    const url = `https://x.test/v1/m:gen?alt=sse&key=${KEY}&access_token=${KEY}&api_key=${KEY}&token=${KEY}`;
    const out = maskString(url);
    expect(out).not.toContain(KEY);
    expect(out).toContain(`?alt=sse&key=${REDACTED}`);
  });

  it("redacts bearer tokens and JSON credential fields in free text", () => {
    const text = `data: {"refresh_token":"${KEY}","access_token":"${KEY}"}\nAuthorization: Bearer ${KEY}`;
    expect(maskString(text)).not.toContain(KEY);
  });

  it("redacts form-encoded OAuth refresh bodies", () => {
    const out = maskString(`refresh_token=${KEY}&client_secret=${KEY}&grant_type=refresh_token`);
    expect(out).not.toContain(KEY);
    expect(out).toContain("grant_type=refresh_token");
  });

  it("leaves non-strings and ordinary text alone", () => {
    expect(maskString(undefined)).toBeUndefined();
    expect(maskString("hello ?monkey=1")).toBe("hello ?monkey=1");
  });
});

describe("maskBody", () => {
  it("redacts OAuth token fields at any depth and keeps the rest", () => {
    const out = maskBody({
      grant_type: "refresh_token",
      refresh_token: KEY,
      client_secret: KEY,
      nested: [{ accessToken: KEY, apiKey: KEY, model: "gpt" }],
      url: `https://x.test/?key=${KEY}`,
      headers: { authorization: `Bearer ${REDACTED}` },
      usage: { total_tokens: 12 },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.grant_type).toBe("refresh_token");
    expect(out.nested[0].model).toBe("gpt");
    expect(out.headers.authorization).toBe(`Bearer ${REDACTED}`);
    expect(out.usage.total_tokens).toBe(12);
  });
});
