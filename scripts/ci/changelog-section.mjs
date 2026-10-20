#!/usr/bin/env node
// Prints the CHANGELOG.md entry for one version (the git-cliff output that `scripts/release.mjs`
// prepends), without its "# vX.Y.Z (date)" heading. The release-notes workflow uses it as the
// GitHub release body for releases cut from a support branch: changelogithub only reads commit
// subjects, and a squash-merged backport PR has a single `chore(release): …` subject, which it
// filters out ("No significant changes").
//
// CLI: node scripts/ci/changelog-section.mjs <version|tag> [CHANGELOG.md]
//   exits 1 when the version has no entry or the entry is empty.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body of the `# v<version>` entry in `changelog`, trimmed; null if missing or empty. */
export function changelogSection(changelog, version) {
  const bare = String(version).trim().replace(/^v/, "");
  const heading = new RegExp(`^# v${escapeRegExp(bare)}(?:\\s|$)`);
  const lines = String(changelog).split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^# /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body || null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]");
    process.exit(2);
  }
  const section = changelogSection(fs.readFileSync(file, "utf8"), version);
  if (!section) {
    console.error(`No CHANGELOG entry for ${version} in ${file}`);
    process.exit(1);
  }
  console.log(section);
}
