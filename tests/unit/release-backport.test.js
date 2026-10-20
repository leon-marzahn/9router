import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { backport, nextSteps, prNumber } from "../../scripts/backport.mjs";
import { branchMajor, release, releaseErrors } from "../../scripts/release.mjs";

const scripts = path.join(import.meta.dirname, "../../scripts");

// Stand-in for `bunx git-cliff --unreleased --tag <tag> --prepend CHANGELOG.md`.
const FAKE_CLIFF = `
const fs = require("node:fs");
const tag = process.argv[process.argv.indexOf("--tag") + 1];
const old = fs.existsSync("CHANGELOG.md") ? fs.readFileSync("CHANGELOG.md", "utf8") : "";
fs.writeFileSync("CHANGELOG.md", "# " + tag + " (2026-01-01)\\n\\n## Fixes\\n- fake entry\\n\\n" + old);
`;

let dir;
let repo;
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (file, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
};
const commit = (subject, files) => {
  for (const [file, content] of Object.entries(files)) write(file, content);
  git("add", "-A");
  git("commit", "-q", "-m", subject);
  return git("rev-parse", "HEAD");
};
const version = () => JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;

/**
 * master: v100.0.0 -> fix(a) #5 -> guard #6 -> notes guard #7 -> v101.0.0 -> fix(b) #8
 *         -> conflict.txt edits #10, #11 (#11 conflicts on v100 without #10)
 */
function buildRepo() {
  git("init", "-q", "-b", "master");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  commit("feat: initial", {
    "package.json": '{\n  "version": "100.0.0"\n}\n',
    "cli/package.json": '{\n  "version": "100.0.0"\n}\n',
    "CHANGELOG.md": "# v100.0.0 (2026-01-01)\n\n- initial\n",
    "conflict.txt": "base\n",
    ".github/workflows/docker-publish.yml": "name: docker\n",
    ".github/workflows/release-notes.yml": "name: notes\n",
  });
  git("tag", "-a", "v100.0.0", "-m", "v100.0.0");
  commit("fix(a): first fix (#5)", { "a.txt": "a\n" });
  commit("ci(release): floating-tag guard (#6)", {
    "scripts/ci/floating-tags.mjs": "// guard\n",
    ".github/workflows/docker-publish.yml": "name: docker\n# node floating-tags.mjs\n",
    ".github/workflows/release-notes.yml": "name: notes\n# node floating-tags.mjs\n",
  });
  commit("ci(release): notes from CHANGELOG (#7)", {
    "scripts/ci/changelog-section.mjs": "// section\n",
    ".github/workflows/release-notes.yml":
      "name: notes\n# node floating-tags.mjs\n# node changelog-section.mjs\n",
  });
  commit("chore(release): v101.0.0", {
    "package.json": '{\n  "version": "101.0.0"\n}\n',
    "cli/package.json": '{\n  "version": "101.0.0"\n}\n',
  });
  git("tag", "-a", "v101.0.0", "-m", "v101.0.0");
  commit("fix(b): second fix (#8)", { "b.txt": "b\n" });
  commit("refactor: rewrite conflict (#10)", { "conflict.txt": "master1\n" });
  commit("fix(c): conflicting fix (#11)", { "conflict.txt": "master2\n" });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-backport-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(dir, "cliff.cjs"), FAKE_CLIFF);
  vi.stubEnv("RELEASE_GIT_CLIFF", path.join(dir, "cliff.cjs"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  buildRepo();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("release.mjs branch and version rules", () => {
  it("maps branches to the major they may release", () => {
    expect(branchMajor("master")).toBe(null);
    expect(branchMajor("support/v100")).toBe(100);
    expect(branchMajor("backport/v100.7.2")).toBe(100);
    expect(branchMajor("feature/x")).toBe(undefined);
  });

  it("keeps master releases as before: bump, changelog, commit, tag", () => {
    release("101.1.0", { cwd: repo });
    expect(version()).toBe("101.1.0");
    expect(git("log", "-1", "--format=%s")).toBe("chore(release): v101.1.0");
    expect(git("tag", "-l", "v101.1.0")).toBe("v101.1.0");
    expect(fs.readFileSync(path.join(repo, "CHANGELOG.md"), "utf8")).toMatch(/^# v101\.1\.0/);
  });

  it("refuses any branch other than master or support/v<major>", () => {
    git("checkout", "-q", "-b", "feature/x");
    expect(() => release("101.1.0", { cwd: repo })).toThrow(/master or a support branch/);
  });

  it("refuses a dirty tree and an existing tag", () => {
    expect(() => release("101.0.0", { cwd: repo })).toThrow(/already exists/);
    write("dirty.txt", "x");
    expect(() => release("101.1.0", { cwd: repo })).toThrow(/not clean/);
  });

  it("releases from a support branch that carries the guards", () => {
    git("checkout", "-q", "-b", "support/v100", "v100.0.0");
    for (const sha of [git("rev-parse", "master~5"), git("rev-parse", "master~4")]) {
      git("cherry-pick", "-x", sha);
    }
    release("100.0.1", { cwd: repo });
    expect(version()).toBe("100.0.1");
    expect(git("tag", "-l", "v100.0.1")).toBe("v100.0.1");
  });

  it("refuses a support release with the wrong major", () => {
    expect(
      releaseErrors({ version: "101.0.1", branch: "support/v100", branchTags: ["v100.0.0"] }),
    ).toEqual([expect.stringMatching(/major must be 100/)]);
  });

  it("refuses a support release not above every tag on the branch", () => {
    const errors = releaseErrors({
      version: "100.0.1",
      branch: "support/v100",
      branchTags: ["v100.0.0", "v100.0.1-rc.1", "v100.0.2"],
    });
    expect(errors).toEqual([expect.stringMatching(/greater than every tag.*v100\.0\.2/)]);
  });

  it("refuses a support branch without the release guards", () => {
    git("checkout", "-q", "-b", "support/v100", "v100.0.0");
    expect(() => release("100.0.1", { cwd: repo })).toThrow(
      /scripts\/ci\/floating-tags\.mjs is missing[\s\S]*changelog-section\.mjs is missing[\s\S]*backport/,
    );
    expect(version()).toBe("100.0.0");
  });

  it("refuses a support branch whose workflows do not call the guard", () => {
    git("checkout", "-q", "-b", "support/v100", "v100.0.0");
    git("cherry-pick", git("rev-parse", "master~5"));
    git("cherry-pick", git("rev-parse", "master~4"));
    commit("ci: drop guard", { ".github/workflows/docker-publish.yml": "name: docker\n" });
    expect(() => release("100.0.1", { cwd: repo })).toThrow(
      /docker-publish\.yml does not call floating-tags\.mjs/,
    );
  });

  it("the CLI exits non-zero with a clear message", () => {
    git("checkout", "-q", "-b", "feature/x");
    let result;
    try {
      execFileSync(process.execPath, [path.join(scripts, "release.mjs"), "101.1.0"], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      result = error;
    }
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toMatch(/Release from master or a support branch/);
  });
});

describe("backport.mjs", () => {
  it("treats #N and short numbers as PRs, anything else as a commit", () => {
    expect(prNumber("#8")).toBe(8);
    expect(prNumber("130")).toBe(130);
    expect(prNumber("1cbb9e9e")).toBe(null);
    expect(prNumber("1234567")).toBe(null);
  });

  it("creates the support branch, picks guards and the PR's commit with -x, and releases", () => {
    const result = backport("100.0.1", ["#8"], { cwd: repo });
    expect(result).toMatchObject({
      tag: "v100.0.1",
      branch: "backport/v100.0.1",
      support: "support/v100",
      pushNeeded: true,
    });
    expect(git("rev-parse", "support/v100")).toBe(git("rev-parse", "v100.0.0^{commit}"));
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("backport/v100.0.1");
    expect(git("log", "--format=%s", "support/v100..HEAD").split("\n")).toEqual([
      "chore(release): v100.0.1",
      "fix(b): second fix (#8)",
      "ci(release): notes from CHANGELOG (#7)",
      "ci(release): floating-tag guard (#6)",
    ]);
    expect(git("log", "-1", "--format=%b", "HEAD~1")).toContain(
      `cherry picked from commit ${git("rev-parse", "master~2")}`,
    );
    expect(version()).toBe("100.0.1");
    expect(git("tag", "-l", "v100.0.1")).toBe("");
    // fix(a) #5 was not requested.
    expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false);
  });

  it("does not pick guards the support branch already has", () => {
    git("branch", "support/v100", "v100.0.0");
    git("checkout", "-q", "support/v100");
    git("cherry-pick", "-x", git("rev-parse", "master~5"));
    git("cherry-pick", "-x", git("rev-parse", "master~4"));
    git("checkout", "-q", "master");
    backport("100.0.1", ["#8"], { cwd: repo });
    expect(git("log", "--format=%s", "support/v100..HEAD").split("\n")).toEqual([
      "chore(release): v100.0.1",
      "fix(b): second fix (#8)",
    ]);
  });

  it("is idempotent: a re-run adds nothing", () => {
    backport("100.0.1", ["#8"], { cwd: repo });
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "master");
    const again = backport("100.0.1", ["#8"], { cwd: repo });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(again.pushNeeded).toBe(true);
  });

  it("refuses to add commits after the release commit", () => {
    backport("100.0.1", ["#8"], { cwd: repo });
    expect(() => backport("100.0.1", ["#8", "#5"], { cwd: repo })).toThrow(
      /already has its release commit/,
    );
  });

  it("stops on a conflict with instructions, and refuses to run mid-cherry-pick", () => {
    expect(() => backport("100.0.1", ["#11"], { cwd: repo })).toThrow(
      /stopped on a conflict[\s\S]*conflict\.txt[\s\S]*cherry-pick --continue[\s\S]*cherry-pick --abort/,
    );
    expect(version()).toBe("100.0.0");
    expect(() => backport("100.0.1", ["#11"], { cwd: repo })).toThrow(/cherry-pick is in progress/);
    // Resolve, continue, re-run: the rest completes.
    write("conflict.txt", "master2\n");
    git("add", "conflict.txt");
    execFileSync("git", ["-c", "core.editor=true", "cherry-pick", "--continue"], {
      cwd: repo,
      stdio: "ignore",
    });
    backport("100.0.1", ["#11"], { cwd: repo });
    expect(git("log", "-1", "--format=%s")).toBe("chore(release): v100.0.1");
    expect(git("log", "--format=%s", "support/v100..HEAD").split("\n")).toHaveLength(4);
  });

  it("rejects unknown PRs and existing tags before changing anything", () => {
    expect(() => backport("100.0.1", ["#99"], { cwd: repo })).toThrow(/No commit on master.*#99/);
    expect(() => backport("101.0.0", ["#8"], { cwd: repo })).toThrow(/already exists/);
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(git("branch", "-l", "support/*")).toBe("");
  });

  it("prints push, PR and tag commands but never runs them", () => {
    const steps = nextSteps(backport("100.0.1", ["#8"], { cwd: repo }));
    expect(steps).toContain("git push -u origin support/v100");
    expect(steps).toContain("git push -u origin backport/v100.0.1");
    expect(steps).toContain("gh pr create --base support/v100 --head backport/v100.0.1");
    expect(steps).toContain("git push origin v100.0.1");
    expect(git("remote")).toBe("");
  });
});
