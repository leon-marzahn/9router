import { describe, expect, it } from "vite-plus/test";
import {
  isMaskedUrl,
  isSecretKey,
  MaskedUrlError,
  maskUrlCredentials,
  redactSecrets,
  restoreMaskedUrl,
  restoreRedacted,
} from "../../src/lib/secretRedaction.js";
import { toProviderConnectionResponse } from "../../src/lib/providerConnectionResponse.js";

const SEEDED = {
  id: "c1",
  provider: "github",
  authType: "oauth",
  apiKey: "sk-top",
  accessToken: "at-top",
  refreshToken: "rt-top",
  idToken: "id-top",
  expiresAt: "2030-01-01",
  providerSpecificData: {
    copilotToken: "cop-secret",
    mimoPassToken: "mimo-secret",
    clientSecret: "cs-secret",
    connectionProxyUrl: "http://alice:pw-secret@proxy.example:8080",
    cookie: "sid=cookie-secret",
    cookies: [{ name: "a", value: "cookies-secret" }],
    token: "plain-token-secret",
    secretAccessKey: "aws-secret",
    sessionToken: "sess-secret",
    password: "pw2-secret",
    passwd: "pw3-secret",
    privateKey: "pk-secret",
    headers: { Authorization: "Bearer hdr-secret", "x-api-key": "xk-secret", Accept: "json" },
    nested: { deep: { refresh_token: "deep-secret" } },
    accessKeyId: "AKIA-visible",
    region: "us-east-1",
    maxTokens: 100,
    useCookie: true,
  },
};

describe("isSecretKey", () => {
  it.each([
    "token", "copilotToken", "refresh_token", "clientSecret", "password", "passwd", "cookie",
    "cookies", "apiKey", "api_key", "privateKey", "secretAccessKey", "Authorization", "x-api-key",
  ])("%s is secret", (k) => expect(isSecretKey(k)).toBe(true));
  it.each(["accessKeyId", "region", "maxTokens", "expiresAt", "tokenType", "name"])("%s is not", (k) =>
    expect(isSecretKey(k)).toBe(false)
  );
});

describe("redactSecrets", () => {
  const out = toProviderConnectionResponse(SEEDED);
  const json = JSON.stringify(out);

  it("leaks none of the seeded secrets", () => {
    for (const secret of json.match(/[a-z0-9-]*secret/g) || []) {
      expect(secret).not.toMatch(/-secret$/);
    }
    for (const v of ["sk-top", "at-top", "rt-top", "id-top", "pw-secret"]) expect(json).not.toContain(v);
  });

  it("replaces values with has<Field> flags", () => {
    expect(out.hasApiKey).toBe(true);
    expect(out.hasAccessToken).toBe(true);
    const psd = out.providerSpecificData;
    expect(psd.hasCopilotToken).toBe(true);
    expect(psd.hasCookies).toBe(true);
    expect(psd.hasSessionToken).toBe(true);
    expect(psd.copilotToken).toBeUndefined();
    expect(psd.headers).toEqual({ hasAuthorization: true, "hasX-api-key": true, Accept: "json" });
    expect(psd.nested.deep).toEqual({ hasRefresh_token: true });
  });

  it("keeps non-secret fields", () => {
    const psd = out.providerSpecificData;
    expect(psd.accessKeyId).toBe("AKIA-visible");
    expect(psd.region).toBe("us-east-1");
    expect(psd.maxTokens).toBe(100);
    expect(psd.useCookie).toBe(true);
    expect(out.expiresAt).toBe("2030-01-01");
  });

  it("masks URL userinfo passwords", () => {
    expect(out.providerSpecificData.connectionProxyUrl).toBe("http://alice:***@proxy.example:8080");
    expect(maskUrlCredentials("socks5://u:p@h:1/x")).toBe("socks5://u:***@h:1/x");
    expect(maskUrlCredentials("http://h:1")).toBe("http://h:1");
    expect(maskUrlCredentials("http://user@h")).toBe("http://***@h");
    expect(redactSecrets({ proxyPools: [{ proxyUrl: "http://a:b@h" }] })).toEqual({
      proxyPools: [{ proxyUrl: "http://a:***@h" }],
    });
  });

  it("leaves empty secret fields and primitives alone", () => {
    expect(redactSecrets({ token: "", apiKey: null })).toEqual({ token: "", apiKey: null });
    expect(redactSecrets(5)).toBe(5);
    expect(toProviderConnectionResponse(null)).toBe(null);
  });
});

describe("restoreRedacted (update without resending the secret)", () => {
  const stored = SEEDED.providerSpecificData;
  const echoed = toProviderConnectionResponse(SEEDED).providerSpecificData;

  it("merging an echoed redacted object keeps every stored secret", () => {
    const merged = { ...stored, ...restoreRedacted({ ...echoed, region: "eu-west-1" }, stored) };
    expect(merged.copilotToken).toBe("cop-secret");
    expect(merged.connectionProxyUrl).toBe(stored.connectionProxyUrl);
    expect(merged.headers.Authorization).toBe("Bearer hdr-secret");
    expect(merged.region).toBe("eu-west-1");
    expect(merged.hasCopilotToken).toBeUndefined();
  });

  it("blank means unchanged, null clears, a new value replaces", () => {
    expect(restoreRedacted({ clientSecret: "" }, stored)).toEqual({});
    expect(restoreRedacted({ clientSecret: null }, stored)).toEqual({ clientSecret: null });
    expect(restoreRedacted({ clientSecret: "new" }, stored)).toEqual({ clientSecret: "new" });
  });

  it("a masked URL on a new host keeps the saved password when the user is unchanged", () => {
    expect(restoreRedacted({ connectionProxyUrl: "http://alice:***@other:1" }, stored)).toEqual({
      connectionProxyUrl: "http://alice:pw-secret@other:1",
    });
    expect(restoreMaskedUrl("http://a:***@h", "http://a:b@h")).toBe("http://a:b@h");
    expect(restoreMaskedUrl("http://a:c@h", "http://a:b@h")).toBe("http://a:c@h");
    expect(restoreMaskedUrl(undefined, "http://a:b@h")).toBe(undefined);
    expect(restoreMaskedUrl("http://***@new", "http://ghp_TOKEN@old")).toBe("http://ghp_TOKEN@new");
    expect(restoreRedacted(null, stored)).toBe(null);
  });

  it("an unresolvable mask is refused instead of storing ***", () => {
    expect(() => restoreMaskedUrl("http://mallory:***@h", "http://a:b@h")).toThrow(MaskedUrlError);
    expect(() => restoreMaskedUrl("http://a:***@h", undefined)).toThrow(/hidden password/);
    expect(() => restoreRedacted({ connectionProxyUrl: "http://bob:***@h" }, stored)).toThrow(MaskedUrlError);
  });

  it("recurses into arrays", () => {
    const prev = { accounts: [{ refreshToken: "rt-1", id: "a" }, { refreshToken: "rt-2", id: "b" }] };
    const echoed = redactSecrets(prev);
    expect(echoed.accounts[0]).toEqual({ hasRefreshToken: true, id: "a" });
    expect(restoreRedacted(echoed, prev)).toEqual(prev);
    expect(restoreRedacted({ list: [{ hasRefreshToken: true }] }, {})).toEqual({ list: [{}] });
    expect(restoreRedacted({ urls: ["http://u:***@h", "x"] }, { urls: ["http://u:p@h"] })).toEqual({
      urls: ["http://u:p@h", "x"],
    });
  });
});

describe("URL userinfo edge cases", () => {
  it.each([
    ["http://carol:p@SECRETPW3@h/x", "http://carol:***@h/x"],
    ["http://dave@SECRETPW4:x@h", "http://***@h"],
    ["http://ghp_TOKEN@github.com/repo", "http://***@github.com/repo"],
    ["  http://u:pw@h", "  http://u:***@h"],
    ["http://h/path@notuserinfo", "http://h/path@notuserinfo"],
    ["http://h?q=a@b", "http://h?q=a@b"],
    ["http://:pw@h", "http://***@h"],
    ["not a url", "not a url"],
  ])("%s -> %s", (input, expected) => {
    expect(maskUrlCredentials(input)).toBe(expected);
    expect(maskUrlCredentials(input)).not.toMatch(/SECRETPW|ghp_TOKEN/);
  });

  it("isMaskedUrl only matches masked userinfo", () => {
    expect(isMaskedUrl("http://u:***@h")).toBe(true);
    expect(isMaskedUrl("http://***@h")).toBe(true);
    expect(isMaskedUrl("http://u:p@h")).toBe(false);
    expect(isMaskedUrl("http://h/***@")).toBe(false);
  });
});

describe("extra secret names", () => {
  it.each(["key", "sessionKey", "session_key", "credentials", "googleCredentials", "bearer", "jwt", "idJwt"])(
    "%s is secret",
    (k) => expect(isSecretKey(k)).toBe(true)
  );
  it.each(["modelKey", "i18nKey", "sortKey", "keyId", "accessKeyId"])("%s is not", (k) =>
    expect(isSecretKey(k)).toBe(false)
  );
});
