#!/usr/bin/env node
// Cut a release: bump root + cli versions, prepend the git-cliff changelog
// entry, commit "chore(release): vX" and tag it. Pushing is left to you:
//   vp run release 100.1.0, then: git push && git push origin v100.1.0
// Push the tag on its own: pushed together with the branch (--follow-tags),
// GitHub did not start the tag workflows (Docker image, release notes).
// The tag push builds the Docker image and writes the GitHub release notes.
//
// Runs on master, or on a support branch for backports (`support/v<major>`, or the
// `backport/v<x.y.z>` branch `scripts/backport.mjs` prepares). On a support branch the version
// must keep that major, be above every tag already on the branch, and the branch must carry the
// release guards (floating-tag guard + CHANGELOG-based release notes), since a tag push runs the
// workflows as they are on the tagged commit.
//
// RELEASE_GIT_CLIFF=<path to a node script> replaces `bunx git-cliff` (tests only).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "./ci/floating-tags.mjs";

export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Files and workflow references a support branch needs before it can be tagged. */
export const RELEASE_GUARDS = [
  { file: "scripts/ci/floating-tags.mjs" },
  { file: ".github/workflows/docker-publish.yml", mustContain: "floating-tags.mjs" },
  { file: ".github/workflows/release-notes.yml", mustContain: "floating-tags.mjs" },
  { file: "scripts/ci/changelog-section.mjs" },
  { file: ".github/workflows/release-notes.yml", mustContain: "changelog-section.mjs" },
];

/** `support/v100` -> 100, `backport/v100.7.2` -> 100, master -> null, anything else -> undefined. */
export function branchMajor(branch) {
  if (branch === "master") return null;
  const support = /^support\/v(\d+)$/.exec(branch);
  if (support) return Number(support[1]);
  const backport = /^backport\/v(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(branch);
  if (backport) return Number(backport[1]);
  return undefined;
}

/** Guards from RELEASE_GUARDS that are missing in `cwd`, as human-readable strings. */
export function missingGuards(cwd = process.cwd()) {
  const missing = [];
  for (const { file, mustContain } of RELEASE_GUARDS) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) missing.push(`${file} is missing`);
    else if (mustContain && !fs.readFileSync(full, "utf8").includes(mustContain)) {
      missing.push(`${file} does not call ${mustContain}`);
    }
  }
  return [...new Set(missing)];
}

/**
 * Branch and version rules, without touching the repo. Returns a list of error messages.
 * `branchTags`: tags reachable from HEAD; `allTags`: every tag in the repo.
 */
export function releaseErrors({ version, branch, branchTags = [], allTags = [], guards = [] }) {
  if (!VERSION_RE.test(version ?? "")) return [`"${version}" is not a x.y.z version`];
  const tag = `v${version}`;
  const errors = [];
  if (allTags.includes(tag)) errors.push(`${tag} already exists`);
  const major = branchMajor(branch);
  if (major === undefined) {
    errors.push(`Release from master or a support branch (support/v<major>), not ${branch}`);
    return errors;
  }
  if (major === null) return errors; // master: unchanged rules
  const self = parseVersion(version);
  if (self.major !== major) {
    errors.push(`${tag} does not belong on ${branch}: its major must be ${major}`);
  }
  const higher = branchTags
    .map(parseVersion)
    .filter((v) => v && compareVersions(v, self) >= 0)
    .map((v) => v.raw);
  if (higher.length) {
    errors.push(`${tag} must be greater than every tag on ${branch} (found ${higher.join(", ")})`);
  }
  for (const guard of guards) {
    errors.push(`Release guard missing on ${branch}: ${guard}`);
  }
  if (guards.length) {
    errors.push(
      "Cherry-pick the commits that added them from master first (`vp run backport` does this).",
    );
  }
  return errors;
}

/** Bump, changelog, commit and (unless `tag: false`) tag. Throws on any rule violation. */
export function release(version, { tag: createTag = true, cwd = process.cwd() } = {}) {
  version = version?.replace(/^v/, "");
  const tag = `v${version}`;
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", cwd }).trim();
  const lines = (s) => s.split("\n").filter(Boolean);

  if (git("status", "--porcelain")) throw new Error("Working tree is not clean");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const errors = releaseErrors({
    version,
    branch,
    branchTags: lines(git("tag", "--merged", "HEAD", "-l", "v*")),
    allTags: lines(git("tag", "-l", "v*")),
    guards: branchMajor(branch) ? missingGuards(cwd) : [],
  });
  if (errors.length) throw new Error(errors.join("\n"));

  // bun.lock records no root version, so only the manifests need bumping.
  for (const file of ["package.json", "cli/package.json"]) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) continue;
    const json = JSON.parse(fs.readFileSync(full, "utf8"));
    json.version = version;
    fs.writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }

  const cliffArgs = ["--unreleased", "--tag", tag, "--prepend", "CHANGELOG.md"];
  const fake = process.env.RELEASE_GIT_CLIFF;
  if (fake) execFileSync(process.execPath, [fake, ...cliffArgs], { stdio: "inherit", cwd });
  else execFileSync("bunx", ["git-cliff@2.14.2", ...cliffArgs], { stdio: "inherit", cwd });

  git("add", "-A");
  git("commit", "-m", `chore(release): ${tag}`);
  if (createTag) git("tag", "-a", tag, "-m", tag);
  return { tag, branch };
}

function main() {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version || !VERSION_RE.test(version)) {
    console.error("usage: vp run release <x.y.z>");
    process.exit(1);
  }
  let tag;
  try {
    ({ tag } = release(version));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(
    `\nTagged ${tag}. Review the CHANGELOG.md diff, then:\n  git push && git push origin ${tag}\n(push the tag separately so GitHub starts the Docker and release-notes workflows)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
