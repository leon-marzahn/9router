import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const settings = { current: {} };
vi.mock("@/lib/localDb", () => ({ getSettings: async () => settings.current }));

const { tunnelExposureProblem } = await import("../../src/lib/tunnel/exposureGuard.js");

describe("tunnel exposure guard", () => {
  beforeEach(() => {
    settings.current = { requireLogin: true, password: "hash", requireApiKey: true };
  });

  it("allows a tunnel when login, a real password and API keys are all required", async () => {
    expect(await tunnelExposureProblem()).toBeNull();
  });

  it.each([
    ["login is off", { requireLogin: false }, /Require login/],
    ["the default password is in use", { password: undefined }, /default dashboard password/],
    ["API keys are not required", { requireApiKey: false }, /Require API key/],
  ])("refuses when %s", async (_, patch, reason) => {
    settings.current = { ...settings.current, ...patch };
    expect(await tunnelExposureProblem()).toMatch(reason);
  });
});
