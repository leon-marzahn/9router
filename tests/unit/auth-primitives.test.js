import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

process.env.JWT_SECRET = "test-jwt-secret-for-auth-primitives";

const limiter = await import("../../src/lib/auth/loginLimiter.js");
const session = await import("../../src/lib/auth/dashboardSession.js");
const apiKey = await import("../../src/shared/utils/apiKey.js");
const bcrypt = (await import("bcryptjs")).default;
const { SignJWT } = await import("jose");

const req = (headers = {}) => ({ headers: new Headers(headers) });

describe("loginLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TRUST_PROXY;
    delete process.env.NINEROUTER_PEER_TOKEN;
  });

  it("locks after 5 failures and escalates the lock on the next round", () => {
    vi.useFakeTimers();
    const ip = "10.0.0.1";
    for (let i = 1; i <= 4; i++) {
      expect(limiter.recordFail(ip).remainingBeforeLock).toBe(5 - i);
      expect(limiter.checkLock(ip).locked).toBe(false);
    }
    limiter.recordFail(ip);
    expect(limiter.checkLock(ip)).toEqual({ locked: true, retryAfter: 30 });

    vi.advanceTimersByTime(30_001);
    expect(limiter.checkLock(ip).locked).toBe(false);
    for (let i = 0; i < 5; i++) limiter.recordFail(ip);
    expect(limiter.checkLock(ip)).toEqual({ locked: true, retryAfter: 120 });
  });

  it("success clears the bucket; buckets are per-IP", () => {
    for (let i = 0; i < 5; i++) limiter.recordFail("10.0.0.2");
    expect(limiter.checkLock("10.0.0.2").locked).toBe(true);
    expect(limiter.checkLock("10.0.0.3").locked).toBe(false);
    limiter.recordSuccess("10.0.0.2");
    expect(limiter.checkLock("10.0.0.2").locked).toBe(false);
  });

  it("forgets stale failures after the 1h window", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 4; i++) limiter.recordFail("10.0.0.4");
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(limiter.recordFail("10.0.0.4").remainingBeforeLock).toBe(4);
  });

  it("getClientIp ignores spoofable headers unless trusted", () => {
    const spoof = req({ "x-9r-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2, 3.3.3.3" });
    expect(limiter.getClientIp(spoof)).toBe("unknown");

    process.env.NINEROUTER_PEER_TOKEN = "peer-secret";
    expect(limiter.getClientIp(req({ "x-9r-real-ip": "1.1.1.1", "x-9r-peer-token": "wrong" }))).toBe("unknown");
    expect(limiter.getClientIp(req({ "x-9r-real-ip": "1.1.1.1", "x-9r-peer-token": "peer-secret" }))).toBe("1.1.1.1");

    process.env.TRUST_PROXY = "true";
    expect(limiter.getClientIp(spoof)).toBe("2.2.2.2");
  });
});

describe("dashboardSession", () => {
  beforeEach(() => {
    delete process.env.INITIAL_PASSWORD;
    delete process.env.AUTH_COOKIE_SECURE;
  });

  it("round-trips a signed token and carries claims", async () => {
    const token = await session.createDashboardAuthToken({ sub: "alice" });
    expect(await session.verifyDashboardAuthToken(token)).toBe(true);
    const payload = await session.getDashboardAuthSession(token);
    expect(payload).toMatchObject({ authenticated: true, sub: "alice" });
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  });

  it("rejects tampered, foreign-key, alg:none and empty tokens", async () => {
    const token = await session.createDashboardAuthToken();
    const [h, p, s] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ authenticated: true, admin: true })).toString("base64url");
    const foreign = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret"));
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${p}.`;
    for (const bad of [`${h}.${forgedPayload}.${s}`, foreign, none, "garbage", "", null, undefined]) {
      expect(await session.verifyDashboardAuthToken(bad)).toBe(false);
      expect(await session.getDashboardAuthSession(bad)).toBe(null);
    }
  });

  it("rejects expired tokens", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ authenticated: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(nowSec - 7200)
      .setExpirationTime(nowSec - 3600)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(await session.verifyDashboardAuthToken(expired)).toBe(false);
  });

  it("sets an httpOnly lax cookie, secure only for https or when forced", async () => {
    const store = { set: vi.fn(), delete: vi.fn() };
    await session.setDashboardAuthCookie(store, req());
    const [name, token, opts] = store.set.mock.calls[0];
    expect(name).toBe("auth_token");
    expect(await session.verifyDashboardAuthToken(token)).toBe(true);
    expect(opts).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 86400 });

    expect(session.shouldUseSecureCookie(req({ "x-forwarded-proto": "https" }))).toBe(true);
    process.env.AUTH_COOKIE_SECURE = "true";
    expect(session.shouldUseSecureCookie(undefined)).toBe(true);

    session.clearDashboardAuthCookie(store);
    expect(store.delete).toHaveBeenCalledWith("auth_token");
  });

  it("verifyDashboardPassword checks the bcrypt hash, else INITIAL_PASSWORD/default", async () => {
    mocks.getSettings.mockResolvedValue({ password: await bcrypt.hash("s3cret!", 4) });
    expect(await session.verifyDashboardPassword("s3cret!")).toBe(true);
    expect(await session.verifyDashboardPassword("123456")).toBe(false);

    mocks.getSettings.mockResolvedValue({});
    expect(await session.verifyDashboardPassword("123456")).toBe(true);
    process.env.INITIAL_PASSWORD = "custom";
    expect(await session.verifyDashboardPassword("123456")).toBe(false);
    expect(await session.verifyDashboardPassword("custom")).toBe(true);

    for (const bad of ["", null, undefined, 123456, { toString: () => "custom" }]) {
      expect(await session.verifyDashboardPassword(bad)).toBe(false);
    }
  });
});

describe("API key format", () => {
  it("generated keys parse back to their machine and key ids", () => {
    const { key, keyId } = apiKey.generateApiKeyWithMachine("abcdef0123456789");
    expect(key).toMatch(/^sk-abcdef0123456789-[a-z0-9]{6}-[0-9a-f]{8}$/);
    expect(apiKey.parseApiKey(key)).toEqual({ machineId: "abcdef0123456789", keyId, isNewFormat: true });
    expect(apiKey.verifyApiKeyCrc(key)).toBe(true);
    expect(apiKey.isNewFormatKey(key)).toBe(true);
  });

  it("rejects keys with a forged CRC or swapped machine id", () => {
    const { key } = apiKey.generateApiKeyWithMachine("abcdef0123456789");
    const [, m, k, crc] = key.split("-");
    const flipped = crc.slice(0, 7) + (crc[7] === "0" ? "1" : "0");
    expect(apiKey.parseApiKey(`sk-${m}-${k}-${flipped}`)).toBe(null);
    expect(apiKey.parseApiKey(`sk-ffffffffffffffff-${k}-${crc}`)).toBe(null);
    expect(apiKey.verifyApiKeyCrc(`sk-${m}-${k}-${flipped}`)).toBe(false);
  });

  it("accepts legacy sk-xxxx keys and rejects other shapes", () => {
    expect(apiKey.parseApiKey("sk-legacy12")).toEqual({ machineId: null, keyId: "legacy12", isNewFormat: false });
    expect(apiKey.verifyApiKeyCrc("sk-legacy12")).toBe(true);
    expect(apiKey.isNewFormatKey("sk-legacy12")).toBe(false);
    for (const bad of [null, "", "pk-abc", "sk-a-b", "sk-a-b-c-d", "Bearer sk-x"]) {
      expect(apiKey.parseApiKey(bad)).toBe(null);
    }
  });
});
