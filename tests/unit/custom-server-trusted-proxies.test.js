// custom-server.js decides whose X-Forwarded-For is believed. The login limiter and the Kiro
// session hash both key on the result, so a forged header must never pick the client IP.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveClientIp, isTrustedProxy } = require("../../custom-server.js").__test__;

const DOCKER = "172.18.0.5";
const CLIENT = "203.0.113.9";
const CF_EDGE = "173.245.48.5";

afterEach(() => {
  delete process.env.TRUSTED_PROXIES;
});

describe("custom-server resolveClientIp", () => {
  it("keeps the peer address for a non-loopback proxy when TRUSTED_PROXIES is unset", () => {
    expect(resolveClientIp(DOCKER, CLIENT, undefined)).toBe(DOCKER);
  });

  it("still adopts forwarded headers from a loopback proxy", () => {
    expect(resolveClientIp("127.0.0.1", `${CLIENT}, 10.0.0.1`, undefined)).toBe(CLIENT);
    expect(resolveClientIp("::1", undefined, CLIENT)).toBe(CLIENT);
  });

  it("adopts the forwarded client from a trusted proxy peer", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12";
    expect(resolveClientIp(DOCKER, CLIENT, undefined)).toBe(CLIENT);
    expect(resolveClientIp(`::ffff:${DOCKER}`, CLIENT, undefined)).toBe(CLIENT);
  });

  it("ignores forwarded headers from a peer that is not listed", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12";
    expect(resolveClientIp("198.51.100.7", "1.2.3.4", undefined)).toBe("198.51.100.7");
  });

  it("skips listed CDN hops and ignores entries forged on the left", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12,173.245.48.0/20";
    expect(resolveClientIp(DOCKER, `127.0.0.1, ${CLIENT}, ${CF_EDGE}`, undefined)).toBe(CLIENT);
  });

  it("returns the unlisted CDN hop when the CDN ranges are not configured", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12";
    expect(resolveClientIp(DOCKER, `${CLIENT}, ${CF_EDGE}`, undefined)).toBe(CF_EDGE);
  });

  it("ignores X-Real-IP from a non-loopback trusted proxy", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12";
    expect(resolveClientIp(DOCKER, CLIENT, "9.9.9.9")).toBe(CLIENT);
    expect(resolveClientIp(DOCKER, undefined, "9.9.9.9")).toBe(DOCKER);
  });

  it("falls back to the peer when the chain is all proxies or malformed", () => {
    process.env.TRUSTED_PROXIES = "172.16.0.0/12";
    expect(resolveClientIp(DOCKER, "172.18.0.2, 172.18.0.3", undefined)).toBe(DOCKER);
    expect(resolveClientIp(DOCKER, "not-an-ip", undefined)).toBe(DOCKER);
    expect(resolveClientIp(DOCKER, `${CLIENT}:4000`, undefined)).toBe(DOCKER);
  });

  it("supports IPv6 ranges and single addresses", () => {
    process.env.TRUSTED_PROXIES = "2400:cb00::/32, 172.18.0.5";
    expect(isTrustedProxy("2400:cb00:1::1")).toBe(true);
    expect(isTrustedProxy("2400:cb01::1")).toBe(false);
    expect(isTrustedProxy(DOCKER)).toBe(true);
    expect(isTrustedProxy("172.18.0.6")).toBe(false);
  });

  it("ignores invalid entries instead of trusting everything", () => {
    process.env.TRUSTED_PROXIES = "nonsense, 10.0.0.0/, 10.0.0.0/abc";
    expect(isTrustedProxy("10.1.2.3")).toBe(false);
    expect(resolveClientIp("10.1.2.3", CLIENT, undefined)).toBe("10.1.2.3");
  });
});
