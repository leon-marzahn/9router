#!/usr/bin/env node
// Compare a Vitest JSON report against the committed known-failures list.
//
//   node scripts/ci/compare-tests.mjs <vitest-report.json> [known-fails.txt]
//
// Exit 1 when a test fails that is not on the list (a regression). Tests on the
// list that now pass are only reported, so the list can be shrunk.
//
// List format (tests/__baseline__/known-fails.txt): one entry per line,
// `<file> :: <full test name>`, or just `<file>` to allow the whole file to
// fail (import/collection errors, live-network suites). `#` starts a comment.
import { appendFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";

const [reportPath, listPath = "tests/__baseline__/known-fails.txt"] = process.argv.slice(2);
if (!reportPath) {
  console.error("usage: compare-tests.mjs <vitest-report.json> [known-fails.txt]");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const known = readFileSync(listPath, "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean);
const knownFiles = new Set(known.filter((l) => !l.includes(" :: ")));
const knownTests = new Set(known.filter((l) => l.includes(" :: ")));

const failed = [];
const passed = new Set();
for (const file of report.testResults) {
  const rel = relative(process.cwd(), file.name).split("\\").join("/");
  // A file that fails to collect has no assertions; count it as one failure.
  if (file.status === "failed" && file.assertionResults.length === 0) {
    failed.push({ file: rel, id: rel });
    continue;
  }
  if (file.status !== "failed") passed.add(rel);
  for (const a of file.assertionResults) {
    const id = `${rel} :: ${a.fullName}`;
    if (a.status === "failed") failed.push({ file: rel, id });
    else if (a.status === "passed") passed.add(id);
  }
}

const regressions = failed.filter((f) => !knownFiles.has(f.file) && !knownTests.has(f.id));
const nowPassing = known.filter((k) => passed.has(k));

const lines = [
  `### Tests vs known failures`,
  ``,
  `${report.numPassedTests} passed, ${report.numFailedTests} failed, ${failed.length - regressions.length} failures on the known list.`,
  ``,
];
if (regressions.length) {
  lines.push(`**${regressions.length} regression(s)** (failing, not in \`${listPath}\`):`, "");
  for (const r of regressions) lines.push(`- \`${r.id}\``);
  lines.push("");
}
if (nowPassing.length) {
  lines.push(
    `**${nowPassing.length} known failure(s) now pass**; remove them from \`${listPath}\`:`,
    "",
  );
  for (const k of nowPassing) lines.push(`- \`${k}\``);
  lines.push("");
}
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
if (process.env.GITHUB_ACTIONS) {
  for (const r of regressions) console.log(`::error title=Test regression::${r.id}`);
  for (const k of nowPassing) console.log(`::notice title=Known failure now passes::${k}`);
}
process.exit(regressions.length ? 1 : 0);
