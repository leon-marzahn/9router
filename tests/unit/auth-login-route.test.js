import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  cookieStore: { set: vi.fn() },
  setDashboardAuthCookie: vi.fn(),
  isOidcConfigured: vi.fn(() => false),
  isSamlConfigured: vi.fn(() => false),
  isLocalRequest: vi.fn(() => true),
  getClientIp: vi.fn(() => "ip-default"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({ status: init.status || 200, body, headers: init.headers || {} }),
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => mocks.cookieStore }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setDashboardAuthCookie }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: mocks.isOidcConfigured }));
vi.mock("@/lib/auth/saml.js", () => ({ isSamlConfigured: mocks.isSamlConfigured }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/lib/auth/loginLimiter", async (orig) => ({
  ...(await orig()),
  getClientIp: mocks.getClientIp,
}));

const { POST } = await import("../../src/app/api/auth/login/route.js");

let ipCounter = 0;
function login(password, { host = "localhost:20128" } = {}) {
  return POST({
    headers: new Headers({ host }),
    json: async () => ({ password }),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.getClientIp.mockReturnValue(`ip-${++ipCounter}`);
    mocks.getSettings.mockResolvedValue({});
  });

  it("accepts the stored bcrypt password and issues a session cookie", async () => {
    mocks.getSettings.mockResolvedValue({ password: await bcrypt.hash("hunter2", 4) });
    const res = await login("hunter2");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mustChangePassword: false });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong password without setting a cookie and counts down attempts", async () => {
    mocks.getSettings.mockResolvedValue({ password: await bcrypt.hash("hunter2", 4) });
    const res = await login("123456");
    expect(res.status).toBe(401);
    expect(res.body.remainingBeforeLock).toBe(4);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("locks the IP after 5 failures, even for the correct password", async () => {
    mocks.getClientIp.mockReturnValue("ip-locked");
    mocks.getSettings.mockResolvedValue({ password: await bcrypt.hash("hunter2", 4) });
    for (let i = 0; i < 4; i++) expect((await login("nope")).status).toBe(401);
    const fifth = await login("nope");
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers["Retry-After"])).toBeGreaterThan(0);

    const correct = await login("hunter2");
    expect(correct.status).toBe(429);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("allows the default password locally on a fresh install", async () => {
    const res = await login("123456");
    expect(res.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalled();
  });

  it("withholds a session from remote clients using the public default password", async () => {
    mocks.isLocalRequest.mockReturnValue(false);
    const res = await login("123456");
    expect(res.status).toBe(403);
    expect(res.body.mustChangePassword).toBe(true);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    // Actionable for remote/Docker users who can't reach the server as "local".
    expect(res.body.error).toMatch(/INITIAL_PASSWORD/);
    expect(res.body.error).toMatch(/restart/);
    expect(res.body.error).toMatch(/Docker/);
  });

  it("honours INITIAL_PASSWORD (and then allows remote login)", async () => {
    process.env.INITIAL_PASSWORD = "set-by-operator";
    mocks.isLocalRequest.mockReturnValue(false);
    expect((await login("123456")).status).toBe(401);
    const ok = await login("set-by-operator");
    expect(ok.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("blocks tunnel hosts unless tunnel dashboard access is enabled", async () => {
    mocks.getSettings.mockResolvedValue({ tunnelUrl: "https://abc.trycloudflare.com" });
    const blocked = await login("123456", { host: "abc.trycloudflare.com" });
    expect(blocked.status).toBe(403);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();

    mocks.getSettings.mockResolvedValue({ tailscaleUrl: "https://box.ts.net", tunnelDashboardAccess: true });
    expect((await login("123456", { host: "box.ts.net:443" })).status).toBe(200);
  });

  it("disables password login when SSO is configured", async () => {
    mocks.getSettings.mockResolvedValue({ authMode: "oidc" });
    mocks.isOidcConfigured.mockReturnValue(true);
    expect((await login("123456")).status).toBe(403);

    mocks.isOidcConfigured.mockReturnValue(false);
    mocks.isSamlConfigured.mockReturnValue(true);
    mocks.getSettings.mockResolvedValue({ authMode: "saml" });
    expect((await login("123456")).status).toBe(403);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("falls back to password login when SSO mode is set but not configured", async () => {
    mocks.isSamlConfigured.mockReturnValue(false);
    mocks.getSettings.mockResolvedValue({ authMode: "sso", ssoType: "saml" });
    expect((await login("123456")).status).toBe(200);
  });

  it("returns 500 on a malformed body instead of authenticating", async () => {
    const res = await POST({ headers: new Headers(), json: async () => { throw new Error("bad json"); } });
    expect(res.status).toBe(500);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });
});
