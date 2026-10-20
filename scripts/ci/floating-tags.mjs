#!/usr/bin/env node
// Decides which floating Docker tags (`latest`, `{major}`, `{major}.{minor}`) a release may move,
// and which release is the repo's highest / the previous one for release notes.
//
// A floating tag only moves when this version is the highest stable version in its scope, so a
// backport (v100.7.1 after v101.0.0) moves `:100` and `:100.7` but never `latest` or `:101`.
// Versions compare numerically (100.10 > 100.9); prereleases never count.
//
// CLI (reads `git tag -l 'v*'` in the cwd; the checkout needs all tags):
//   node scripts/ci/floating-tags.mjs floating <version>   -> "latest 100 100.7" (may be empty)
//   node scripts/ci/floating-tags.mjs highest              -> "v101.0.1" (highest stable tag)
//   node scripts/ci/floating-tags.mjs previous <version>   -> "v100.7.0" (highest tag below it)
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEMVER =
  /^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parses "v1.2.3" / "1.2.3-rc.1"; returns null for anything that is not plain semver. */
export function parseVersion(input) {
  const match = SEMVER.exec(String(input).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    raw: String(input).trim(),
  };
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return (a.prerelease.length ? -1 : 0) - (b.prerelease.length ? -1 : 0);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const diff = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (diff) return diff;
  }
  return 0;
}

const isStable = (v) => v.prerelease.length === 0;

function maxOf(versions) {
  return versions.reduce((best, v) => (!best || compareVersions(v, best) > 0 ? v : best), null);
}

/**
 * Floating tags `version` may move, given every release tag in the repo (the version itself
 * is counted even if missing from `tags`). Prereleases and unparseable input get none.
 */
export function floatingTags(version, tags) {
  const self = parseVersion(version);
  if (!self || !isStable(self)) return [];
  const stable = [self, ...tags.map(parseVersion).filter((v) => v && isStable(v))];
  const isTop = (scope) => compareVersions(self, maxOf(stable.filter(scope))) >= 0;

  const result = [];
  if (isTop(() => true)) result.push("latest");
  if (isTop((v) => v.major === self.major)) result.push(String(self.major));
  if (isTop((v) => v.major === self.major && v.minor === self.minor)) {
    result.push(`${self.major}.${self.minor}`);
  }
  return result;
}

/** The highest stable tag, as written in `tags`, or null. */
export function highestStable(tags) {
  return maxOf(tags.map(parseVersion).filter((v) => v && isStable(v)))?.raw ?? null;
}

/**
 * The tag release notes for `version` should diff against: the highest tag below it, ignoring
 * prereleases when `version` is stable. Null for the first release.
 */
export function previousTag(version, tags) {
  const self = parseVersion(version);
  if (!self) return null;
  const candidates = tags
    .map(parseVersion)
    .filter((v) => v && compareVersions(v, self) < 0 && (!isStable(self) || isStable(v)));
  return maxOf(candidates)?.raw ?? null;
}

function gitTags() {
  return execFileSync("git", ["tag", "-l", "v*"], { encoding: "utf8" })
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

function main([command, version]) {
  const tags = gitTags();
  if (command === "floating" && version) return floatingTags(version, tags).join(" ");
  if (command === "highest") return highestStable(tags) ?? "";
  if (command === "previous" && version) return previousTag(version, tags) ?? "";
  console.error("usage: floating-tags.mjs floating <version> | highest | previous <version>");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(main(process.argv.slice(2)));
}
