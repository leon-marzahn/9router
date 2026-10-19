// The per-key pricing routes are dashboard-only: no session, no access (even from
// a request carrying a customer's API key).
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  next: Symbol("next"),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.next),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

function request(pathname, { cookie, headers = {} } = {}) {
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    headers: new Headers(headers),
    cookies: { get: vi.fn(() => (cookie ? { value: cookie } : undefined)) },
    url: `http://localhost${pathname}`,
  };
}

const ROUTES = ["/api/pricing/plans", "/api/pricing/plans/default", "/api/keys/k1/plan"];

describe("per-key pricing routes need a dashboard session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(true);
    mocks.verifyDashboardAuthToken.mockImplementation(async (t) => t === "good");
  });

  it.each(ROUTES)("%s refuses anonymous and API-key callers", async (path) => {
    expect((await proxy(request(path))).status).toBe(401);
    const withKey = request(path, { headers: { Authorization: "Bearer sk-customer" } });
    expect((await proxy(withKey)).status).toBe(401);
  });

  it.each(ROUTES)("%s lets a signed-in dashboard through", async (path) => {
    expect(await proxy(request(path, { cookie: "good" }))).toBe(mocks.next);
  });
});
