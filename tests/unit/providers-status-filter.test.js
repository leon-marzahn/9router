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

describe("provider model cooldowns", () => {
  it("merges active per-model locks across accounts and ignores expired ones", async () => {
    const { cooldownsOf } = await import("@/app/(dashboard)/dashboard/providers/model.ts");
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    const list = buildProviders(
      [
        conn({ name: "a", "modelLock_claude-opus": soon, "modelLock_old-model": past }),
        conn({ name: "b", "modelLock_claude-opus": later }),
        conn({ name: "c", modelLock_: soon }),
      ],
      [],
    );
    const cds = cooldownsOf(find(list, "claude"));
    expect(cds.map((c) => c.model).sort()).toEqual(["__all", "claude-opus"]);
    const opus = cds.find((c) => c.model === "claude-opus");
    expect(opus.until).toBe(later);
    expect(opus.accounts).toEqual(["a", "b"]);
  });
});
