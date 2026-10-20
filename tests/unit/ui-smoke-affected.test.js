import { describe, expect, it } from "vite-plus/test";
import {
  affectedSections,
  apiOf,
  CORE_ROUTES,
  importsOf,
  routeSelected,
  sectionOf,
} from "../../scripts/ui-smoke/affected.mjs";

const D = "src/app/(dashboard)/dashboard";

/** A small app: token-saver imports profile's hook relatively, usage via `@/`. */
const sources = new Map([
  [`${D}/profile/settings/useSettings.js`, `fetch("/api/settings")`],
  [`${D}/token-saver/page.js`, `import { useSettings } from "../profile/settings/useSettings";`],
  [`${D}/endpoint/Gatehouse.tsx`, `import x from "@/app/(dashboard)/dashboard/usage/live/shared";`],
  [`${D}/usage/live/useUsage.ts`, "fetch(`/api/usage/${id}`); fetch('/api/usage-export')"],
  [`${D}/combos/page.js`, `const r = await fetch("/api/combos?x=1");`],
  ["src/ui/budget/Budget.tsx", `fetch("/api/budgets/" + scope)`],
]);

describe("ui-smoke affected routes", () => {
  it("maps page files to their dashboard section", () => {
    expect(sectionOf(`${D}/usage/live/RequestDrawer.tsx`)).toBe("/dashboard/usage");
    expect(sectionOf(`${D}/page.js`)).toBe("/dashboard");
    expect(sectionOf("src/app/customer/page.tsx")).toBe("/customer");
    expect(sectionOf("src/app/api/keys/route.js")).toBeNull();
    expect(sectionOf("open-sse/handlers/chatCore.js")).toBeNull();
    expect(apiOf("src/app/api/usage/[id]/route.js")).toBe("usage");
    expect(apiOf(`${D}/usage/page.js`)).toBeNull();
  });

  it("resolves relative and @/ imports against the importing file", () => {
    expect(
      importsOf(
        `${D}/token-saver/page.js`,
        `import a from "../profile/settings/useSettings";\nimport b from "@/ui";\nimport c from "react";\nconst d = import("./lazy");`,
      ),
    ).toEqual([`${D}/profile/settings/useSettings`, "src/ui", `${D}/token-saver/lazy`]);
  });

  it("runs everything when shared code, config or the smoke itself changes", () => {
    for (const f of [
      "src/ui/Dialog.tsx",
      "src/app/globals.css",
      "src/app/layout.js",
      "src/app/(dashboard)/layout.js",
      "src/shared/components/Modal.js",
      "src/shared/utils/ssrfGuard.js",
      "src/lib/db/index.js",
      "src/dashboardGuard.js",
      "open-sse/handlers/chatCore.js",
      "custom-server.js",
      "vite.config.ts",
      "scripts/ui-smoke.mjs",
      "scripts/ui-smoke/states.json",
      "scripts/pr-shots/seed.mjs",
      "package.json",
    ]) {
      expect(affectedSections([f], sources).full, f).toBe(true);
    }
  });

  it("only runs the core set for docs, tests and unrelated scripts", () => {
    expect(
      affectedSections(["docs/DESIGN.md", "tests/unit/x.test.js", "scripts/release.mjs"], sources),
    ).toEqual({ full: false, sections: [] });
  });

  it("follows page sections to the sections importing from them", () => {
    expect(affectedSections([`${D}/profile/settings/useSettings.js`], sources)).toEqual({
      full: false,
      sections: ["/dashboard/profile", "/dashboard/token-saver"],
    });
    expect(affectedSections([`${D}/usage/live/LiveTraffic.tsx`], sources)).toEqual({
      full: false,
      sections: ["/dashboard/endpoint", "/dashboard/usage"],
    });
  });

  it("maps API routes to the pages calling them", () => {
    expect(affectedSections(["src/app/api/usage/[id]/route.js"], sources)).toEqual({
      full: false,
      sections: ["/dashboard/endpoint", "/dashboard/usage"],
    });
    expect(affectedSections(["src/app/api/combos/route.js"], sources).sections).toEqual([
      "/dashboard/combos",
    ]);
    // `/api/usage-export` is not `/api/usage`.
    expect(affectedSections(["src/app/api/usage-export/route.js"], sources).sections).toEqual([
      "/dashboard/endpoint",
      "/dashboard/usage",
    ]);
    expect(affectedSections(["src/app/api/nobody/route.js"], sources).sections).toEqual([]);
    // Called from shared UI: could be any page.
    expect(affectedSections(["src/app/api/budgets/route.js"], sources).full).toBe(true);
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
