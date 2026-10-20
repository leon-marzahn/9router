import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { changelogSection } from "../../scripts/ci/changelog-section.mjs";

const script = path.join(import.meta.dirname, "../../scripts/ci/changelog-section.mjs");

const CHANGELOG = `
# v100.7.10 (2026-10-21)

## Fixes
- **x**: Not this one

# v100.7.1 (2026-10-20)

## Fixes
- **pxpipe**: Pin pxpipe-proxy and refuse to load an unverified copy (#127)

## Build & CI
- **release**: Only move floating tags and GitHub Latest for the highest release (#128)

# v100.7.0 (2026-10-20)

## Features
- older
`;

describe("changelogSection", () => {
  it("returns the entry body without its heading, up to the next entry", () => {
    expect(changelogSection(CHANGELOG, "v100.7.1")).toBe(
      [
        "## Fixes",
        "- **pxpipe**: Pin pxpipe-proxy and refuse to load an unverified copy (#127)",
        "",
        "## Build & CI",
        "- **release**: Only move floating tags and GitHub Latest for the highest release (#128)",
      ].join("\n"),
    );
  });

  it("matches the exact version, with or without v, and reads the last entry to EOF", () => {
    expect(changelogSection(CHANGELOG, "100.7.10")).toBe("## Fixes\n- **x**: Not this one");
    expect(changelogSection(CHANGELOG, "100.7.0")).toBe("## Features\n- older");
  });

  it("returns null for a missing or empty entry", () => {
    expect(changelogSection(CHANGELOG, "100.7.2")).toBe(null);
    expect(changelogSection("# v1.0.0 (x)\n\n# v0.9.0 (y)\n- a\n", "1.0.0")).toBe(null);
  });

  it("CLI prints the section and fails when it is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-section-"));
    const file = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(file, CHANGELOG);
    try {
      const out = execFileSync(process.execPath, [script, "v100.7.1", file], { encoding: "utf8" });
      expect(out).toMatch(/^## Fixes\n- \*\*pxpipe\*\*/);
      expect(() =>
        execFileSync(process.execPath, [script, "v9.9.9", file], { stdio: "pipe" }),
      ).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
