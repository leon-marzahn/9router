/**
 * Quota Tracker view state comes from the URL only: a bare /dashboard/quota
 * (entering from the nav) is the default overview, deep links still select.
 */
import { describe, it, expect } from "vite-plus/test";
import { quotaViewFromParams } from "../../src/app/(dashboard)/dashboard/quota/workbench/viewState.ts";

const view = (qs) => quotaViewFromParams(new URLSearchParams(qs));

describe("quotaViewFromParams", () => {
  it("a bare URL is the default overview: nothing selected, 24h span", () => {
    expect(view("")).toEqual({ sel: null, span: 24, overview: false });
  });

  it("deep links select an account or a provider (account wins)", () => {
    expect(view("account=a1").sel).toEqual({ kind: "account", id: "a1" });
    expect(view("provider=codex").sel).toEqual({ kind: "provider", id: "codex" });
    expect(view("provider=codex&account=a1").sel).toEqual({ kind: "account", id: "a1" });
  });

  it("reads ?range= and falls back to 24h for unknown values", () => {
    expect(view("range=6h").span).toBe(6);
    expect(view("range=7d").span).toBe(168);
    expect(view("range=bogus").span).toBe(24);
  });

  it("?view=overview applies only with nothing selected", () => {
    expect(view("view=overview").overview).toBe(true);
    expect(view("view=overview&account=a1").overview).toBe(false);
  });
});
