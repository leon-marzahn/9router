import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// src/proxy.js is the Next.js middleware entry: it gates the Xiaomi login
// forwarder behind dashboard auth before falling through to dashboardGuard.
const mocks = vi.hoisted(() => ({
  dashboardProxy: vi.fn(),
  isAuthenticated: vi.fn(),
  sessionFromRequest: vi.fn(),
  proxyAccountRequest: vi.fn(),
  runTakeover: vi.fn(),
}));

vi.mock("../../src/dashboardGuard", () => ({
  proxy: mocks.dashboardProxy,
  isAuthenticated: mocks.isAuthenticated,
}));
vi.mock("../../src/lib/mimoLoginSession", async (orig) => ({
  ...(await orig()),
  sessionFromRequest: mocks.sessionFromRequest,
  proxyAccountRequest: mocks.proxyAccountRequest,
  runTakeover: mocks.runTakeover,
  attachSessionCookie: (res) => res,
}));

const { default: proxy } = await import("../../src/proxy.js");

const CLEAR = "9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

function makeReq(pathname, cookie = "") {
  const url = new URL(`http://localhost:20128${pathname}`);
  return {
    url: url.href,
    headers: new Headers(cookie ? { cookie, host: "localhost:20128" } : { host: "localhost:20128" }),
    nextUrl: { pathname: url.pathname, search: url.search },
  };
}

describe("src/proxy.js middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.dashboardProxy.mockImplementation(async () => new Response("guard", { status: 200 }));
  });

  it("without a mimo cookie, delegates straight to the dashboard guard", async () => {
    const res = await proxy(makeReq("/dashboard"));
    expect(await res.text()).toBe("guard");
    expect(mocks.isAuthenticated).not.toHaveBeenCalled();
    expect(mocks.proxyAccountRequest).not.toHaveBeenCalled();
  });

  it("a forged mimo cookie without dashboard auth is never forwarded and gets cleared", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.dashboardProxy.mockResolvedValue(new Response("login required", { status: 401 }));
    const res = await proxy(makeReq("/pass/serviceLogin", "9r_mimo_login=forged"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBe(CLEAR);
    expect(mocks.sessionFromRequest).not.toHaveBeenCalled();
    expect(mocks.proxyAccountRequest).not.toHaveBeenCalled();
    expect(mocks.runTakeover).not.toHaveBeenCalled();
  });

  it("authenticated with a valid session, forwards account-login paths", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.sessionFromRequest.mockReturnValue({ id: "s1", upstreamBase: "https://up", jar: {} });
    mocks.proxyAccountRequest.mockResolvedValue(new Response("upstream", { status: 200 }));
    const res = await proxy(makeReq("/pass/serviceLogin", "9r_mimo_login=ok"));
    expect(mocks.proxyAccountRequest).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("upstream");
    expect(mocks.dashboardProxy).not.toHaveBeenCalled();
  });

  it("returns 502 when the upstream login proxy throws", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.sessionFromRequest.mockReturnValue({ id: "s1", upstreamBase: "https://up", jar: {} });
    mocks.proxyAccountRequest.mockRejectedValue(new Error("boom"));
    const res = await proxy(makeReq("/pass/serviceLogin", "9r_mimo_login=ok"));
    expect(res.status).toBe(502);
  });

  it("authenticated but undecodable session falls through to the guard and clears the cookie", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.sessionFromRequest.mockReturnValue(null);
    const res = await proxy(makeReq("/pass/serviceLogin", "9r_mimo_login=junk"));
    expect(await res.text()).toBe("guard");
    expect(res.headers.get("set-cookie")).toBe(CLEAR);
    expect(mocks.proxyAccountRequest).not.toHaveBeenCalled();
  });

  it("authenticated with a session, non-login paths still go through the guard", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.sessionFromRequest.mockReturnValue({ id: "s1", upstreamBase: "https://up", jar: {} });
    const res = await proxy(makeReq("/api/settings", "9r_mimo_login=ok"));
    expect(await res.text()).toBe("guard");
    expect(mocks.proxyAccountRequest).not.toHaveBeenCalled();
    expect(mocks.runTakeover).not.toHaveBeenCalled();
  });
});
