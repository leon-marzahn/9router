import { describe, expect, it } from "vite-plus/test";
import {
  affectedSections,
  CORE_ROUTES,
  routeSelected,
  sectionOf,
} from "../../scripts/ui-smoke/affected.mjs";

describe("ui-smoke affected routes", () => {
  it("maps page files to their dashboard section", () => {
    expect(sectionOf("src/app/(dashboard)/dashboard/usage/live/RequestDrawer.tsx")).toBe(
      "/dashboard/usage",
    );
    expect(sectionOf("src/app/(dashboard)/dashboard/page.js")).toBe("/dashboard");
    expect(sectionOf("src/app/customer/page.tsx")).toBe("/customer");
    expect(sectionOf("src/app/api/keys/route.js")).toBeNull();
    expect(sectionOf("open-sse/handlers/chatCore.js")).toBeNull();
  });

  it("runs everything when shared UI or the smoke itself changes", () => {
    for (const f of [
      "src/ui/Dialog.tsx",
      "src/app/globals.css",
      "src/app/layout.js",
      "src/app/(dashboard)/layout.js",
      "src/app/(dashboard)/dashboard/layout.js",
      "src/shared/components/Modal.js",
      "scripts/ui-smoke.mjs",
      "scripts/ui-smoke/states.json",
      "scripts/pr-shots/seed.mjs",
      "package.json",
    ]) {
      expect(affectedSections([f]).full, f).toBe(true);
    }
  });

  it("narrows to the changed sections plus importers", () => {
    const hit = affectedSections(
      [
        "src/app/(dashboard)/dashboard/usage/live/LiveTraffic.tsx",
        "src/app/api/usage/route.js",
        "docs/DESIGN.md",
      ],
      { importers: (s) => (s === "/dashboard/usage" ? ["/dashboard/endpoint"] : []) },
    );
    expect(hit).toEqual({ full: false, sections: ["/dashboard/endpoint", "/dashboard/usage"] });
  });

  it("selects routes and states by section, always keeping the core set", () => {
    const sections = ["/dashboard/usage", "/customer"];
    expect(routeSelected("/dashboard/usage", sections)).toBe(true);
    expect(routeSelected("/dashboard/usage/x?view=overview", sections)).toBe(true);
    expect(routeSelected("/customer#signed-in", sections)).toBe(true);
    expect(routeSelected("/dashboard/usages", sections)).toBe(false);
    expect(routeSelected("/dashboard/combos", sections)).toBe(false);
    for (const r of CORE_ROUTES) expect(routeSelected(r, [])).toBe(true);
    // The /dashboard section is the home page only, not every route below it.
    expect(routeSelected("/dashboard/combos", ["/dashboard"])).toBe(false);
  });
});
