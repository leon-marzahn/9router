import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ consumeClaudeResetGrant: vi.fn() }));
vi.mock("open-sse/services/usage/claude.js", () => ({ getClaudeUsage: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection })),
}));

const { getProviderConnectionById } = await import("@/lib/localDb");
const { consumeClaudeResetGrant } = await import("open-sse/services/usage.js");
const { getClaudeUsage } = await import("open-sse/services/usage/claude.js");
const { POST } = await import("@/app/api/usage/[connectionId]/claude-reset/route.js");

const call = (body) =>
  POST(new Request("http://localhost/api/usage/c1/claude-reset", { method: "POST", body: JSON.stringify(body ?? {}) }), {
    params: Promise.resolve({ connectionId: "c1" }),
  });

const grants = {
  nextGrantId: "g_next",
  grants: [
    { id: "g_next", resetsLeft: 1, paused: false },
    { id: "g_other", resetsLeft: 2, paused: false },
    { id: "g_paused", resetsLeft: 1, paused: true },
  ],
};

describe("POST /api/usage/:id/claude-reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnectionById.mockResolvedValue({ id: "c1", provider: "claude", authType: "oauth", accessToken: "tok" });
    getClaudeUsage.mockResolvedValue({ resetCredits: grants });
    consumeClaudeResetGrant.mockResolvedValue({ ok: true, status: 200, result: "reset" });
  });

  it("picks the account's next grant itself when none is given", async () => {
    expect((await call()).status).toBe(200);
    expect(consumeClaudeResetGrant).toHaveBeenCalledWith("tok", "g_next", expect.anything());
  });

  it("honours a client grant id only if it is a usable grant on the account", async () => {
    await call({ grantId: "g_other" });
    expect(consumeClaudeResetGrant).toHaveBeenCalledWith("tok", "g_other", expect.anything());

    for (const bad of ["g_paused", "g_someone_else"]) {
      consumeClaudeResetGrant.mockClear();
      expect((await call({ grantId: bad })).status).toBe(409);
      expect(consumeClaudeResetGrant).not.toHaveBeenCalled();
    }
  });

  it("refuses when the account has no usable grants", async () => {
    getClaudeUsage.mockResolvedValue({ resetCredits: { nextGrantId: null, grants: [] } });
    expect((await call()).status).toBe(409);
    expect(consumeClaudeResetGrant).not.toHaveBeenCalled();
  });
});
