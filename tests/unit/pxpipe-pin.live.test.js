import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  PXPIPE_INTEGRITY,
  PXPIPE_REGISTRY,
  PXPIPE_SPEC,
  PXPIPE_TREE_SHA256,
  treeHash,
} from "../../src/lib/pxpipe/pin.js";
import { importGraph } from "./helpers/pxpipeImportGraph.js";

// Live network test: opt in with RUN_REAL=1 (same switch as tests/translator/real/*).
// Packs the pinned release from the registry and checks the pin constants.
const RUN_REAL = process.env.RUN_REAL === "1";

describe.skipIf(!RUN_REAL)("pxpipe pin matches the published tarball (live)", () => {
  it("integrity, tree hash and a self-contained library.js", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxpipe-pack-"));
    try {
      const out = execFileSync(
        "npm",
        ["pack", PXPIPE_SPEC, "--ignore-scripts", `--registry=${PXPIPE_REGISTRY}`, "--json"],
        { cwd: dir, encoding: "utf8" },
      );
      const [{ integrity, filename }] = JSON.parse(out);
      expect(integrity).toBe(PXPIPE_INTEGRITY);

      execFileSync("tar", ["xzf", filename], { cwd: dir });
      const root = path.join(dir, "package");
      expect(treeHash(root)).toBe(PXPIPE_TREE_SHA256);
      expect(importGraph(path.join(root, "dist", "core", "library.js")).external).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
