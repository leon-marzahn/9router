import { describe, it, expect } from "vite-plus/test";
import { resolveBaseUrl } from "../../open-sse/handlers/search/callers.js";

const CONFIG = { id: "searxng", baseUrl: "https://searxng.example.com" };

describe("resolveBaseUrl", () => {
  it("uses provider default when the connection sets none", () => {
    expect(resolveBaseUrl(CONFIG, {})).toBe("https://searxng.example.com");
  });

  // A client-chosen base URL received the operator's search API key.
  it("rejects a client-supplied provider_options.baseUrl, even a public one", () => {
    for (const baseUrl of ["https://attacker.example.com", "http://127.0.0.1:18999", "", 42]) {
      const params = { providerOptions: { baseUrl } };
      expect(() => resolveBaseUrl(CONFIG, params), `should reject ${baseUrl}`).toThrow(/not allowed/);
    }
  });

  it("uses the connection's public https baseUrl", () => {
    const params = { providerSpecificData: { baseUrl: "https://my-searxng.example.com/" } };
    expect(resolveBaseUrl(CONFIG, params)).toBe("https://my-searxng.example.com");
  });

  it("uses the connection's public http baseUrl", () => {
    const params = { providerSpecificData: { baseUrl: "http://searxng.example.net" } };
    expect(resolveBaseUrl(CONFIG, params)).toBe("http://searxng.example.net");
  });
});

describe("resolveBaseUrl SSRF guard on the connection's baseUrl", () => {
  const withBase = (baseUrl) => ({ providerSpecificData: { baseUrl } });

  it("rejects loopback", () => {
    expect(() => resolveBaseUrl(CONFIG, withBase("http://127.0.0.1:18999"))).toThrow();
  });

  it("rejects private IPs", () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1"]) {
      expect(() => resolveBaseUrl(CONFIG, withBase(`http://${ip}`)), `should reject ${ip}`).toThrow();
    }
  });

  it("rejects localhost", () => {
    expect(() => resolveBaseUrl(CONFIG, withBase("http://localhost:8080"))).toThrow();
  });

  it("rejects cloud metadata", () => {
    expect(() => resolveBaseUrl(CONFIG, withBase("http://169.254.169.254/latest/meta-data"))).toThrow();
  });

  it("rejects non-http protocols", () => {
    for (const proto of ["file:///etc/passwd", "gopher://127.0.0.1:70", "ftp://10.0.0.1"]) {
      expect(() => resolveBaseUrl(CONFIG, withBase(proto)), `should reject ${proto}`).toThrow();
    }
  });
});
