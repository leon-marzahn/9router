import { describe, expect, it } from "vite-plus/test";
import {
  computeDiffCoverage,
  isGated,
  parseDiff,
  parseLcov,
  ranges,
} from "../../scripts/ci/diff-coverage.mjs";

const DIFF = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -3,0 +4,3 @@ ctx
+x
+y
+z
@@ -10 +13 @@
-old
+new
@@ -20,2 +22,0 @@
-gone
-gone
diff --git a/src/del.js b/src/del.js
--- a/src/del.js
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/tests/unit/x.test.js b/tests/unit/x.test.js
--- /dev/null
+++ b/tests/unit/x.test.js
@@ -0,0 +1,2 @@
+a
+b
`;

describe("diff-coverage", () => {
  it("maps hunks to new-side line numbers, ignoring pure deletions", () => {
    const d = parseDiff(DIFF);
    expect([...d.get("src/a.js")]).toEqual([4, 5, 6, 13]);
    expect(d.has("src/del.js")).toBe(false);
    expect([...d.get("tests/unit/x.test.js")]).toEqual([1, 2]);
  });

  it("parses lcov with absolute and relative paths", () => {
    const l = parseLcov("SF:/r/src/a.js\nDA:4,1\nDA:5,0\nend_of_record\nSF:src/b.js\nDA:1,2\nend_of_record\n", "/r");
    expect(l.get("src/a.js").get(5)).toBe(0);
    expect(l.get("src/b.js").get(1)).toBe(2);
  });

  it("counts only executable changed lines in gated files", () => {
    const lcov = parseLcov("SF:src/a.js\nDA:4,1\nDA:6,0\nDA:13,3\nend_of_record\n");
    const r = computeDiffCoverage(parseDiff(DIFF), lcov);
    expect(r.total).toBe(3); // line 5 is not executable; test file not gated
    expect(r.covered).toBe(2);
    expect(r.files[0].uncovered).toEqual([6]);
  });

  it("treats gated files missing from the report as uncovered", () => {
    const r = computeDiffCoverage(new Map([["open-sse/x.js", new Set([1, 2])]]), new Map());
    expect(r.pct).toBe(0);
    expect(r.files[0].missing).toBe(true);
  });

  it("gates source but not tests, generated or non-code files", () => {
    expect(isGated("src/ui/Button.tsx")).toBe(true);
    expect(isGated("cli/src/x.mjs")).toBe(true);
    expect(isGated("open-sse/providers/registry/index.js")).toBe(false);
    expect(isGated("src/foo.test.js")).toBe(false);
    expect(isGated("src/types.d.ts")).toBe(false);
    expect(isGated("cli/package.json")).toBe(false);
    expect(isGated("scripts/ci/x.mjs")).toBe(false);
  });

  it("collapses line ranges", () => {
    expect(ranges([1, 2, 3, 7, 9, 10])).toBe("1-3, 7, 9-10");
  });
});
