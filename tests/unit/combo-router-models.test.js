// Router model candidates for a smart combo: System One models of providers the
// operator has an active account on, then (labelled) the free no-account lanes.
import { describe, it, expect } from "vite-plus/test";
import {
  FREE_ROUTER_NOTE,
  isFreeThirdPartyRouter,
  systemOneGroups,
} from "../../src/app/(dashboard)/dashboard/combos/workbench/routerModels.ts";

const ids = (groups) => groups.flatMap((g) => g.models.map((m) => m.id));

describe("systemOneGroups", () => {
  it("lists System One models of connected providers", () => {
    const groups = systemOneGroups([{ provider: "ollama", isActive: true }]);
    expect(ids(groups)).toEqual(expect.arrayContaining(["ollama/clef", "ollama/clef-flash"]));
    expect(groups.every((g) => g.models.length > 0)).toBe(true);
    // Chat-only models of the same provider are not router candidates.
    expect(ids(groups).every((id) => !id.startsWith("ollama/") || /clef/.test(id))).toBe(true);
  });

  it("ignores paused accounts", () => {
    const groups = systemOneGroups([{ provider: "ollama", isActive: false }]);
    expect(ids(groups).some((id) => id.startsWith("ollama/"))).toBe(false);
  });
});

describe("free third-party router lanes", () => {
  it("come after authenticated lanes and are labelled", () => {
    const groups = systemOneGroups([{ provider: "ollama", isActive: true }]);
    const free = groups.map((g) => isFreeThirdPartyRouter(g.models[0].id));
    expect(free[0]).toBe(false);
    const firstFree = free.indexOf(true);
    expect(firstFree).toBeGreaterThan(-1);
    expect(free.slice(firstFree).every(Boolean)).toBe(true);
    for (const g of groups.filter((x) => isFreeThirdPartyRouter(x.models[0].id))) {
      // The caution is its own line on each option (wraps on mobile), not part of a title.
      expect(g.models.every((m) => m.note === FREE_ROUTER_NOTE)).toBe(true);
      expect(g.providerName).not.toContain(FREE_ROUTER_NOTE);
    }
  });

  it("knows which stored router ids are free lanes", () => {
    expect(isFreeThirdPartyRouter("oc/jev-1.13-free")).toBe(true);
    expect(isFreeThirdPartyRouter("ollama/clef-flash")).toBe(false);
    expect(isFreeThirdPartyRouter(null)).toBe(false);
  });
});
