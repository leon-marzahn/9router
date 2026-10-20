import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
  getSettings: vi.fn(),
  verifyDashboardPassword: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: mocks.getSettings,
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "real-cli-token"),
}));

const { GET, POST } = await import("../../src/app/api/settings/database/route.js");
const { cliTokenMatches } = await import("../../src/lib/auth/cliToken.js");

const URL = "http://localhost/api/settings/database";

function get(headers = {}) {
  return GET(new Request(URL, { headers }));
}
function post(body, headers = {}) {
  return POST(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exportDb.mockResolvedValue({ providerConnections: [{ apiKey: "sk-x" }] });
  mocks.importDb.mockResolvedValue(undefined);
  mocks.getSettings.mockResolvedValue({});
  mocks.verifyDashboardPassword.mockImplementation(async (p) => p === "right-pass");
});

describe("settings/database CLI token", () => {
  it.each([
    ["wrong", { "x-9r-cli-token": "x" }],
    ["prefix of the real token", { "x-9r-cli-token": "real-cli" }],
    ["missing", {}],
    ["empty", { "x-9r-cli-token": "" }],
  ])("denies export with a %s token and no password", async (_name, headers) => {
    const res = await get(headers);
    expect(res.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("allows export with the real CLI token", async () => {
    const res = await get({ "x-9r-cli-token": "real-cli-token" });
    expect(res.status).toBe(200);
    expect(mocks.exportDb).toHaveBeenCalledOnce();
  });

  it("session path still needs the password for export", async () => {
    expect((await get({ "x-9r-password": "nope" })).status).toBe(401);
    expect((await get({ "x-9r-password": "right-pass" })).status).toBe(200);
  });

  it("denies import with a fake token and no password", async () => {
    const res = await post({ providerConnections: [] }, { "x-9r-cli-token": "x" });
    expect(res.status).toBe(401);
    expect(mocks.importDb).not.toHaveBeenCalled();
  });

  it("allows import with the real token or the password", async () => {
    expect((await post({}, { "x-9r-cli-token": "real-cli-token" })).status).toBe(200);
    expect((await post({ password: "right-pass" })).status).toBe(200);
    expect((await post({ password: "wrong" })).status).toBe(401);
    expect(mocks.importDb).toHaveBeenCalledTimes(2);
  });

  it("cliTokenMatches rejects non-strings and different lengths", () => {
    expect(cliTokenMatches("abc", "abc")).toBe(true);
    expect(cliTokenMatches("abcd", "abc")).toBe(false);
    expect(cliTokenMatches(undefined, "abc")).toBe(false);
    expect(cliTokenMatches("abc", "")).toBe(false);
  });
});
