// Router model candidates for a smart combo: System One models of providers the
// operator has an active account on (or that need none), as alias/model ids.
import { describe, it, expect } from "vite-plus/test";
import { systemOneGroups } from "../../src/app/(dashboard)/dashboard/combos/workbench/routerModels.ts";

const ids = (groups) => groups.flatMap((g) => g.models.map((m) => m.id));

describe("systemOneGroups", () => {
  it("lists System One models of connected providers only", () => {
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
