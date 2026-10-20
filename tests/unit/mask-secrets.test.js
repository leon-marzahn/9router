// Request logs, MITM dumps and debug output must never contain usable credentials.
import { describe, it, expect } from "vite-plus/test";
import { REDACTED, isSecretHeader, maskHeaders, maskString, maskBody, knownSecrets, redactValues, redactValuesDeep } from "../../open-sse/utils/maskSecrets.cjs";

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
    for (const h of ["x-access-token", "x-client-secret", "x-session-token", "x-amz-security-token", "x-custom-key", "anthropic-api-key", "x-auth"]) {
      expect(isSecretHeader(h), h).toBe(true);
    }
    for (const h of ["content-type", "user-agent", "anthropic-version", "x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-limit", "keep-alive", "x-request-id", "accept", "x-session-id", "x-session-affinity"]) {
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

describe("review bypasses", () => {
  const S = "SEKRET123456";
  it("masks camelCase, bare and escaped JSON fields inside strings", () => {
    expect(maskString(JSON.stringify({ refreshToken: S, token: S, key: S, secret: S, "x-goog-api-key": S }))).not.toContain(S);
    expect(maskString(`{"api_key":"a\\"${S}"}`)).not.toContain(S);
    expect(maskString(JSON.stringify(JSON.stringify({ access_token: S })))).not.toContain(S);
    expect(maskString(`{"api_key": 123456789}`)).not.toContain("123456789");
  });

  it("masks bare and object-valued secret fields in bodies", () => {
    expect(JSON.stringify(maskBody({ token: S, secret: S, key: S }))).not.toContain(S);
    expect(maskBody({ client_secret: { value: S } })).toEqual({ client_secret: { value: REDACTED } });
    expect(maskBody({ auth: { type: "oauth", token: S } })).toEqual({ auth: { type: "oauth", token: REDACTED } });
  });

  it("masks raw header lines, key prefixes, encoded param names and fragments", () => {
    expect(maskString(`x-api-key: ${S}`)).toBe(`x-api-key: ${REDACTED}`);
    expect(maskString(`Authorization: Basic ${S}`)).toBe(`Authorization: Basic ${REDACTED}`);
    for (const k of [`sk-ant-${S}`, `sk-proj-${S}abcdefgh`, `AIza${S}${S}${S}`, `gsk_${S}${S}`]) {
      expect(maskString(`invalid key ${k} given`)).toBe(`invalid key ${REDACTED} given`);
    }
    expect(maskString(`https://h/v1?api%5Fkey=${S}`)).not.toContain(S);
    expect(maskString(`https://h/p#key=${S}`)).not.toContain(S);
    expect(maskString("sk-short and AIza")).toBe("sk-short and AIza");
  });
});

describe("value redaction", () => {
  it("collects credential strings and redacts them in any encoding", () => {
    const secrets = knownSecrets({ apiKey: "prov-key-abcdef", accessToken: "acc-tok-123456", refreshToken: null }, "client/key+12345", "short");
    expect(secrets).toEqual(["prov-key-abcdef", "acc-tok-123456", "client/key+12345"]);
    const text = `bad key prov-key-abcdef; tok acc-tok-123456; url ?x=${encodeURIComponent("client/key+12345")}`;
    expect(redactValues(text, secrets)).toBe(`bad key ${REDACTED}; tok ${REDACTED}; url ?x=${REDACTED}`);
    expect(redactValues(text, [])).toBe(text);
    expect(redactValuesDeep({ a: [{ m: "prov-key-abcdef" }], n: 1 }, secrets)).toEqual({ a: [{ m: REDACTED }], n: 1 });
  });
});

describe("over-masking guards", () => {
  it("keeps tool schemas whose properties are named like secrets", () => {
    const tools = [
      { name: "login", input_schema: { type: "object", properties: { password: { type: "string" }, token: { type: "string", description: "x" } } } },
      { type: "function", function: { name: "f", parameters: { properties: { api_key: { type: "string" } } } } },
    ];
    expect(maskBody({ tools })).toEqual({ tools });
    expect(maskBody({ schema: { key: "string" } })).toEqual({ schema: { key: "string" } });
  });

  it("keeps prose 'Basic ...' and masks real Basic credentials and cookie2", () => {
    expect(maskString("Basic information about the model")).toBe("Basic information about the model");
    expect(maskString("Authorization header: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization header: Basic ${REDACTED}`);
    expect(isSecretHeader("Cookie2")).toBe(true);
  });
});
