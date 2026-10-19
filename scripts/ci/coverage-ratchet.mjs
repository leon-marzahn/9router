// Coverage ratchet: overall line coverage may not drop below the committed baseline
// (tests/__baseline__/coverage.json) minus a 0.1pp tolerance.
// Usage:
//   node scripts/ci/coverage-ratchet.mjs check  [coverage/coverage-summary.json]
//   node scripts/ci/coverage-ratchet.mjs update [coverage/coverage-summary.json]
// `update` only ever raises the baseline. Run it after `bun run coverage` when your PR
// raises coverage (CI hints when it rose by more than 0.5pp) and commit the baseline.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASELINE = new URL("../../tests/__baseline__/coverage.json", import.meta.url);
const TOLERANCE = 0.1;

const [mode = "check", file = "coverage/coverage-summary.json"] = process.argv.slice(2);
if (!existsSync(file)) {
  console.log(`## Coverage ratchet\n\n_No ${file}; cannot check._`);
  process.exit(1);
}
const pct = JSON.parse(readFileSync(file, "utf8")).total.lines.pct;
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).lines : 0;

if (mode === "update") {
  if (pct > base) {
    writeFileSync(BASELINE, JSON.stringify({ lines: pct }, null, 2) + "\n");
    console.log(`Baseline raised ${base}% -> ${pct}%.`);
  } else console.log(`Baseline stays at ${base}% (current ${pct}%).`);
  process.exit(0);
}

const ok = pct >= base - TOLERANCE;
const out = [
  "## Coverage ratchet",
  "",
  `Line coverage **${pct}%**, baseline ${base}% (tolerance ${TOLERANCE}pp).`,
];
if (!ok) out.push("", "> Failing: overall line coverage dropped below the baseline. Add tests.");
else if (pct > base + 0.5)
  out.push(
    "",
    "> Coverage rose: run `node scripts/ci/coverage-ratchet.mjs update` and commit the baseline.",
  );
console.log(out.join("\n"));
process.exit(ok ? 0 : 1);
