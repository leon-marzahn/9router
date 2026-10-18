import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = { current: {} };
const updateSettings = vi.fn(async (patch) => (store.current = { ...store.current, ...patch }));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => store.current, updateSettings }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: () => {} }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: () => {} }));
vi.mock("@/lib/request-pipelines/config.js", () => ({ validatePipelines: (p) => p }));

const { PATCH } = await import("../../src/app/api/settings/route.js");
const patch = (body) => PATCH(new Request("http://x/api/settings", { method: "PATCH", body: JSON.stringify(body) }));

describe("settings PATCH sign-in guards", () => {
  beforeEach(async () => {
    updateSettings.mockClear();
    store.current = { requireLogin: true, password: await bcrypt.hash("hunter2", 4), authMode: "password", ssoType: "oidc" };
  });

  it("needs the current password to turn login off", async () => {
    expect((await patch({ requireLogin: false })).status).toBe(400);
    expect((await patch({ requireLogin: false, currentPassword: "nope" })).status).toBe(401);
    expect(updateSettings).not.toHaveBeenCalled();
    const ok = await patch({ requireLogin: false, currentPassword: "hunter2" });
    expect(ok.status).toBe(200);
    expect(store.current.requireLogin).toBe(false);
    expect(store.current.currentPassword).toBeUndefined();
  });

  it("refuses an SSO sign-in mode until that provider is configured", async () => {
    expect((await patch({ authMode: "sso", ssoType: "saml" })).status).toBe(400);
    expect((await patch({ authMode: "both", ssoType: "oidc", oidcIssuerUrl: "https://idp", oidcClientId: "c" })).status).toBe(400);
    const ok = await patch({ authMode: "both", ssoType: "oidc", oidcIssuerUrl: "https://idp", oidcClientId: "c", oidcClientSecret: "s" });
    expect(ok.status).toBe(200);
  });

  it("never stores the plain-text password fields", async () => {
    await patch({ currentPassword: "x", theme: "dark" });
    expect(store.current.currentPassword).toBeUndefined();
  });
});
