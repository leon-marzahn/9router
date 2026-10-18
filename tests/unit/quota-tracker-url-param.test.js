/**
 * Quota Tracker deep links (#4217): /dashboard/quota?provider=codex opens that
 * provider, ?account=<id> opens one account, and selecting either updates the
 * URL. The workbench is a client component, so the source text is checked.
 */
import { describe, it, expect } from "vite-plus/test";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/quota/workbench/QuotaWorkbench.tsx"),
  "utf-8",
);

describe("Quota workbench — URL selection sync (#4217)", () => {
  it("reads the selection from ?provider= and ?account=", () => {
    expect(src).toContain("useSearchParams");
    expect(src).toMatch(/searchParams\.get\("provider"\)/);
    expect(src).toMatch(/searchParams\.get\("account"\)/);
  });

  it("writes the selection back with router.replace", () => {
    expect(src).toContain("useRouter");
    expect(src).toContain("router.replace");
    expect(src).toContain('params.delete("provider")');
    expect(src).toContain("params.set(");
  });
});
