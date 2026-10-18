#!/usr/bin/env node
// Cut a release: bump root + cli versions, prepend the git-cliff changelog
// entry, commit "chore(release): vX" and tag it. Pushing is left to you:
//   npm run release 100.1.0 && git push --follow-tags
// The tag push builds the Docker image and writes the GitHub release notes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: npm run release <x.y.z>");
  process.exit(1);
}
const tag = `v${version}`;
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

if (git("status", "--porcelain")) throw new Error("Working tree is not clean");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "master") throw new Error("Release from master");
if (git("tag", "-l", tag)) throw new Error(`${tag} already exists`);

for (const file of [
  "package.json",
  "cli/package.json",
  "package-lock.json",
  "cli/package-lock.json",
]) {
  if (!fs.existsSync(file)) continue;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  if (json.packages?.[""]) json.packages[""].version = version;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

execFileSync(
  "npx",
  ["--yes", "git-cliff@2.14.2", "--unreleased", "--tag", tag, "--prepend", "CHANGELOG.md"],
  {
    stdio: "inherit",
  },
);

git("add", "-A");
git("commit", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", tag);
console.log(`\nTagged ${tag}. Review the CHANGELOG.md diff, then: git push --follow-tags`);
