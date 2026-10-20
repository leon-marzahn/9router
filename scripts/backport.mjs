#!/usr/bin/env node
// Prepare a backport release (e.g. v100.7.2 after v101.0.0) on a local branch:
//   vp run backport <x.y.z> <commit-or-PR#>...
//
//   1. `support/v<major>`: reused if it exists locally (fast-forwarded to origin's copy when
//      that is ahead), else created from origin's copy, else from the highest `v<major>.*` tag.
//   2. `backport/v<x.y.z>` is created from it (or reused on a re-run).
//   3. Missing release guards are cherry-picked from master first: the commits that added
//      `scripts/ci/floating-tags.mjs` (keeps Docker `latest` and the GitHub "Latest" release on the
//      highest version) and `scripts/ci/changelog-section.mjs` (release notes from CHANGELOG.md).
//      A tag push runs the workflows as they are on the tagged commit, so the branch needs them.
//   4. The given commits are cherry-picked with `-x`. `#123` / `123` is resolved to the commit on
//      master whose subject ends in "(#123)" (the squash-merge of that PR).
//   5. The release step of `scripts/release.mjs` runs: version bump, git-cliff CHANGELOG entry,
//      "chore(release): v<x.y.z>" commit. No tag.
//
// Nothing is pushed or tagged; the script prints the commands for that. Order of releases:
// the highest version first, backports after. Safe to re-run: applied commits (by SHA or by
// their "cherry picked from" trailer) are skipped, and a finished branch only reprints the
// next steps. On a conflict it stops and says how to continue or abort.
//
// Guards are detected by file presence only. A later fix on master to the guard scripts or to
// the release workflows is not picked automatically: backport that commit explicitly.
//
// After the tag push: Docker moves only the floating tags this version is the highest in
// (`:{major}`, `:{major}.{minor}`), never `latest`; the GitHub release body is the tag's
// CHANGELOG.md entry, published with --latest=false. If a backport still moved `latest`, dispatch
// the Docker publish workflow with `release_tag` set to the highest tag and `promote_latest=true`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "./ci/floating-tags.mjs";
import { VERSION_RE, missingGuards, release, releaseErrors } from "./release.mjs";

/** Files whose adding commit on master is cherry-picked when the branch lacks a guard. */
export const GUARD_FILES = ["scripts/ci/floating-tags.mjs", "scripts/ci/changelog-section.mjs"];

class BackportError extends Error {}

function makeGit(cwd) {
  const run = (args, opts = {}) =>
    execFileSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"], ...opts })
      .toString()
      .trim();
  const ok = (args) => {
    try {
      run(args);
      return true;
    } catch {
      return false;
    }
  };
  return { run, ok };
}

/** "#123" / "123" (up to 6 digits) is a PR number; anything else is a commit-ish. */
export function prNumber(ref) {
  const match = /^#?(\d{1,6})$/.exec(String(ref).trim());
  return match ? Number(match[1]) : null;
}

/**
 * The upstream commit recorded in `forkedFrom.commit` of package.json on `masterRef`, if this
 * clone has it. Everything reachable from it is 9router's history, not ours.
 */
export function upstreamBase(git, masterRef) {
  let commit;
  try {
    commit = JSON.parse(git.run(["show", `${masterRef}:package.json`]))?.forkedFrom?.commit;
  } catch {
    return null;
  }
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  return git.ok(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]) ? commit : null;
}

/** The commit on `masterRef` whose subject ends in "(#n)". */
export function resolvePr(git, masterRef, n) {
  // First parent only: merged upstream history carries its own, colliding PR numbers. That is
  // not enough on its own: the fork was branched off 9router's master, so 9router's commits
  // before the fork point are on our first-parent line too. Exclude everything reachable from
  // the upstream commit we last synced to (`forkedFrom.commit`). Without that marker (a shallow
  // or partial clone), a collision still refuses rather than guessing.
  const base = upstreamBase(git, masterRef);
  const out = git.run([
    "log",
    "--first-parent",
    masterRef,
    ...(base ? ["--not", base] : []),
    "--format=%H%x09%s",
    "-F",
    "--grep",
    `(#${n})`,
  ]);
  const hits = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, subject]) => subject.endsWith(`(#${n})`));
  if (hits.length === 0) throw new BackportError(`No commit on ${masterRef} ends in "(#${n})"`);
  if (hits.length > 1) {
    throw new BackportError(
      `Several commits on ${masterRef} end in "(#${n})"; pass the SHA instead:\n` +
        hits.map(([sha, s]) => `  ${sha.slice(0, 12)} ${s}`).join("\n"),
    );
  }
  return hits[0][0];
}

function resolveCommit(git, masterRef, ref) {
  const n = prNumber(ref);
  if (n !== null) return resolvePr(git, masterRef, n);
  try {
    return git.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new BackportError(`Unknown commit: ${ref}`);
  }
}

/** Already on HEAD: itself, a `cherry-pick -x` copy, or a patch-equivalent commit. */
function isApplied(git, sha) {
  if (git.ok(["merge-base", "--is-ancestor", sha, "HEAD"])) return true;
  const trailer = git.run([
    "log",
    "HEAD",
    "--format=%H",
    "-F",
    "--grep",
    `cherry picked from commit ${sha}`,
  ]);
  if (trailer) return true;
  // `git cherry` prints "- <sha>" when HEAD already has a commit with the same patch-id.
  if (!git.ok(["rev-parse", "--verify", `${sha}^`])) return false;
  return git.run(["cherry", "HEAD", sha, `${sha}^`]).startsWith("-");
}

function guardCommits(git, masterRef, cwd) {
  if (missingGuards(cwd).length === 0) return [];
  const shas = [];
  for (const file of GUARD_FILES) {
    const added = git.run(["log", masterRef, "--diff-filter=A", "--format=%H", "--", file]);
    const sha = added.split("\n").filter(Boolean).pop();
    if (!sha) throw new BackportError(`${masterRef} has no commit adding ${file}`);
    if (!shas.includes(sha)) shas.push(sha);
  }
  // Oldest first, so the later guard applies on top of the earlier one.
  return shas.sort((a, b) => (git.ok(["merge-base", "--is-ancestor", a, b]) ? -1 : 1));
}

function cherryPick(git, sha, { version, args }) {
  const subject = git.run(["log", "-1", "--format=%s", sha]);
  try {
    git.run(["cherry-pick", "-x", sha]);
    console.log(`  picked ${sha.slice(0, 12)} ${subject}`);
  } catch {
    const conflicted = git.run(["diff", "--name-only", "--diff-filter=U"]);
    throw new BackportError(
      [
        `Cherry-pick of ${sha.slice(0, 12)} (${subject}) stopped on a conflict.`,
        conflicted ? `Conflicted files:\n${conflicted.replace(/^/gm, "  ")}` : "",
        "Resolve it, then:",
        "  git add <files> && git cherry-pick --continue",
        `  node scripts/backport.mjs ${version} ${args.join(" ")}   # re-run: picks the rest, then releases`,
        "Re-run with node, not vp: a vp/node shim can fail to parse package.json while it still",
        "has conflict markers. If the pick came out empty and you ran `git cherry-pick --skip`,",
        "re-run without that commit.",
        "Or give up on this backport:",
        "  git cherry-pick --abort",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function highestTagOfMajor(git, major) {
  const tags = git
    .run(["tag", "-l", `v${major}.*`])
    .split("\n")
    .map(parseVersion)
    .filter((v) => v && v.major === major && v.prerelease.length === 0);
  if (!tags.length) throw new BackportError(`No v${major}.* release tag to branch from`);
  return tags.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)).raw;
}

/** The ref `support/v<major>` is (or will be) created from, without creating anything. */
function supportBase(git, major) {
  const support = `support/v${major}`;
  if (git.ok(["rev-parse", "--verify", `refs/heads/${support}`])) return support;
  if (git.ok(["rev-parse", "--verify", `refs/remotes/origin/${support}`])) {
    return `origin/${support}`;
  }
  return highestTagOfMajor(git, major);
}

function prepareSupport(git, major) {
  const support = `support/v${major}`;
  const remote = `origin/${support}`;
  const hasLocal = git.ok(["rev-parse", "--verify", `refs/heads/${support}`]);
  const hasRemote = git.ok(["rev-parse", "--verify", `refs/remotes/${remote}`]);
  if (hasLocal) {
    if (
      hasRemote &&
      git.run(["rev-parse", support]) !== git.run(["rev-parse", remote]) &&
      git.ok(["merge-base", "--is-ancestor", support, remote])
    ) {
      git.run(["branch", "-f", support, remote]);
      console.log(`Fast-forwarded ${support} to ${remote}`);
    }
    return { support, created: false, pushNeeded: !hasRemote };
  }
  if (hasRemote) {
    git.run(["branch", "--track", support, remote]);
    console.log(`Created ${support} from ${remote}`);
    return { support, created: true, pushNeeded: false };
  }
  const base = highestTagOfMajor(git, major);
  git.run(["branch", support, base]);
  console.log(`Created ${support} from ${base}`);
  return { support, created: true, pushNeeded: true };
}

/** Prepares the backport branch; returns what the next steps need. Throws BackportError. */
export function backport(version, refs, { cwd = process.cwd() } = {}) {
  version = String(version ?? "").replace(/^v/, "");
  if (!VERSION_RE.test(version) || !refs.length) {
    throw new BackportError("usage: vp run backport <x.y.z> <commit-or-PR#>...");
  }
  const git = makeGit(cwd);
  const tag = `v${version}`;
  const major = parseVersion(version).major;
  const branch = `backport/${tag}`;
  const gitDir = git.run(["rev-parse", "--git-dir"]);

  if (fs.existsSync(path.resolve(cwd, gitDir, "CHERRY_PICK_HEAD"))) {
    throw new BackportError(
      "A cherry-pick is in progress. Finish it (git add <files> && git cherry-pick --continue)" +
        " or abort it (git cherry-pick --abort), then re-run.",
    );
  }
  if (git.run(["status", "--porcelain", "--untracked-files=no"])) {
    throw new BackportError("Working tree has uncommitted changes; commit or stash them first.");
  }
  if (git.run(["tag", "-l", tag])) throw new BackportError(`${tag} already exists`);

  const masterRef = git.ok(["rev-parse", "--verify", "refs/remotes/origin/master"])
    ? "origin/master"
    : "master";
  // Resolve everything before switching branches, so a typo changes nothing.
  const commits = [...new Set(refs.map((ref) => resolveCommit(git, masterRef, ref)))];

  // Version and major rules against the support branch's tags, before any side effect.
  const base = supportBase(git, major);
  const lines = (s) => s.split("\n").filter(Boolean);
  const errors = releaseErrors({
    version,
    branch: `support/v${major}`,
    branchTags: lines(git.run(["tag", "--merged", base, "-l", "v*"])),
    allTags: lines(git.run(["tag", "-l", "v*"])),
  });
  if (errors.length) throw new BackportError(errors.join("\n"));

  const { support, pushNeeded } = prepareSupport(git, major);
  if (git.ok(["rev-parse", "--verify", `refs/heads/${branch}`])) {
    git.run(["checkout", "-q", branch]);
    console.log(`Reusing ${branch}`);
  } else {
    git.run(["checkout", "-q", "-b", branch, support]);
    console.log(`Created ${branch} from ${support}`);
  }

  const releaseSubject = `chore(release): ${tag}`;
  const released = git
    .run(["log", `${support}..HEAD`, "--format=%s"])
    .split("\n")
    .some((s) => s === releaseSubject || s.startsWith(`${releaseSubject} (#`));

  const guards = guardCommits(git, masterRef, cwd);
  const pending = [...guards, ...commits.filter((sha) => !guards.includes(sha))].filter(
    (sha) => !isApplied(git, sha),
  );
  if (released && pending.length) {
    throw new BackportError(
      `${branch} already has its release commit, but these are not on it:\n` +
        pending.map((sha) => `  ${sha.slice(0, 12)}`).join("\n") +
        `\nDrop the release commit (git reset --hard HEAD~1) and re-run.`,
    );
  }
  for (const sha of pending) cherryPick(git, sha, { version, args: refs });
  if (!pending.length) console.log("All commits already applied.");

  if (released) console.log(`${releaseSubject} is already on ${branch}.`);
  else release(version, { tag: false, cwd });

  return { tag, branch, support, pushNeeded };
}

export function nextSteps({ tag, branch, support, pushNeeded }) {
  return [
    "",
    `Prepared ${branch}. Review the CHANGELOG.md entry and the picked commits, then:`,
    "",
    "1. Push the branches:",
    ...(pushNeeded ? [`   git push -u origin ${support}`] : []),
    `   git push -u origin ${branch}`,
    "",
    `2. Open the PR into ${support}:`,
    `   gh pr create --base ${support} --head ${branch} --title "chore(release): ${tag}" --body "Backport release ${tag}."`,
    "",
    `3. After it is merged, check the version on ${support}, then tag it and push the tag on its own:`,
    `   git fetch origin && git show origin/${support}:package.json | grep '"version"'   # must show ${tag.slice(1)}`,
    `   git tag -a ${tag} -m ${tag} origin/${support} && git push origin ${tag}`,
    "",
    "Release the highest version first; backports come after it.",
  ].join("\n");
}

function main() {
  const [version, ...refs] = process.argv.slice(2);
  try {
    console.log(nextSteps(backport(version, refs)));
  } catch (error) {
    console.error(error instanceof BackportError ? error.message : String(error.message ?? error));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
