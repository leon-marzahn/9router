import { describe, expect, it } from "vite-plus/test";
import { buildProviders } from "@/app/(dashboard)/dashboard/providers/model.ts";

// The Providers workbench replaced the status-filter dropdown with status
// grouping; these cover the same derivation (none / paused / active / no-auth).
const conn = (over = {}) => ({ id: Math.random().toString(36).slice(2), provider: "claude", authType: "oauth", testStatus: "active", ...over });
const find = (list, id) => list.find((p) => p.id === id);

describe("providers status derivation", () => {
  it("classifies a provider with no connections as none", () => {
    expect(find(buildProviders([], []), "claude").status).toBe("none");
  });

  it("classifies a provider whose only connections are disabled as paused", () => {
    const list = buildProviders([conn({ isActive: false }), conn({ isActive: false })], []);
    expect(find(list, "claude").status).toBe("paused");
  });

  it("classifies a provider with at least one enabled connection as ok", () => {
    const list = buildProviders([conn({ isActive: false }), conn()], []);
    expect(find(list, "claude").status).toBe("ok");
  });

  it("treats noAuth providers as ready even with no stored connection", () => {
    const noAuth = buildProviders([], []).find((p) => p.noAuth);
    expect(noAuth?.status).toBe("ready");
  });

  it("distinguishes degraded (some failing) from error (all failing)", () => {
    const degraded = buildProviders([conn(), conn({ testStatus: "error", lastErrorType: "upstream_rate_limited" })], []);
    expect(find(degraded, "claude").status).toBe("degraded");
    expect(find(degraded, "claude").stats.errorCode).toBe("429");
    const failing = buildProviders([conn({ testStatus: "expired", lastErrorType: "token_expired" })], []);
    expect(find(failing, "claude").status).toBe("error");
    expect(find(failing, "claude").stats.errorCode).toBe("AUTH");
  });

  it("sorts problems before healthy and unconfigured providers", () => {
    const list = buildProviders([conn({ testStatus: "error" })], []);
    expect(list[0].id).toBe("claude");
    expect(list.at(-1).status).toBe("none");
  });
});
