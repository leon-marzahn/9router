#!/usr/bin/env node
// Publish screenshots to the orphan `pr-assets` branch under pr-<number>/ and
// print Markdown for the PR's Evidence section.
//
//   node scripts/pr-shots-publish.mjs --pr 35 [--dir pr-shots] [--remote origin] [--dry-run]
//
// Uses git plumbing with a temporary index, so the working tree and current
// branch are untouched. The branch is created on first use. The repo is
// public: only publish screenshots of demo data (scripts/pr-shots.mjs).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    pr: { type: "string" },
    dir: { type: "string", default: "pr-shots" },
    remote: { type: "string", default: "origin" },
    branch: { type: "string", default: "pr-assets" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!/^\d+$/.test(args.pr ?? "")) {
  console.error(
    "usage: pr-shots-publish.mjs --pr <number> [--dir pr-shots] [--remote origin] [--dry-run]",
  );
  process.exit(2);
}

const dir = resolve(args.dir);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".png"))
  .sort();
if (!files.length) throw new Error(`no .png files in ${dir}`);

const tmp = mkdtempSync(join(tmpdir(), "pr-assets-"));
const gitEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
const git = (argv, opts = {}) =>
  execFileSync("git", argv, { encoding: "utf8", env: gitEnv, ...opts }).trim();

try {
  const ref = `refs/remotes/${args.remote}/${args.branch}`;
  let parent = null;
  try {
    git(["fetch", "--quiet", "--no-tags", args.remote, `+refs/heads/${args.branch}:${ref}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    parent = git(["rev-parse", "--verify", ref]);
  } catch {
    console.error(`${args.branch} not found on ${args.remote}; creating it as an orphan branch.`);
  }

  if (parent) git(["read-tree", parent]);
  else git(["read-tree", "--empty"]);
  const prefix = `pr-${args.pr}`;
  // Replace the PR's folder wholesale so re-runs don't leave stale images.
  git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", prefix]);
  for (const f of files) {
    const blob = git(["hash-object", "-w", join(dir, f)]);
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${prefix}/${basename(f)}`]);
  }
  const tree = git(["write-tree"]);
  const commit = git([
    "commit-tree",
    tree,
    ...(parent ? ["-p", parent] : []),
    "-m",
    `pr-${args.pr}: screenshots`,
  ]);

  if (args["dry-run"]) console.error(`dry run: built ${commit}, not pushed`);
  else
    git(["push", "--quiet", args.remote, `${commit}:refs/heads/${args.branch}`], {
      stdio: "inherit",
    });

  const url = git(["remote", "get-url", args.remote]);
  const slug = url.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  if (!slug) throw new Error(`remote ${args.remote} is not a GitHub URL: ${url}`);
  // Pin links to the commit so later re-runs don't change an old PR's images.
  for (const f of files) {
    const name = basename(f, ".png");
    console.log(`![${name}](https://raw.githubusercontent.com/${slug}/${commit}/${prefix}/${f})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
