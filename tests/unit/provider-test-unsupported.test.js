import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// A provider with no connection test (e.g. zed) must not be marked as failing
// when tested — otherwise one "Health check" errors every working account.
const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

describe("testSingleConnection for providers without a test", () => {
  beforeEach(() => {
    mocks.getProviderConnectionById.mockReset();
    mocks.updateProviderConnection.mockReset();
  });

  it("reports unsupported and leaves the stored health untouched", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "c1",
      provider: "zed",
      authType: "oauth",
      testStatus: "active",
      accessToken: "t",
    });
    const result = await testSingleConnection("c1");
    expect(result.unsupported).toBe(true);
    expect(result.valid).toBeNull();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
