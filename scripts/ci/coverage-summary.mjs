// Prints the v8 coverage totals as a Markdown table for the GitHub job summary.
// Usage: node scripts/ci/coverage-summary.mjs coverage/coverage-summary.json
import { existsSync, readFileSync } from "node:fs";

const file = process.argv[2] ?? "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log("_No coverage report was written._");
  process.exit(0);
}

const { total } = JSON.parse(readFileSync(file, "utf8"));
const rows = ["lines", "statements", "functions", "branches"].map(
  (k) =>
    `| ${k[0].toUpperCase()}${k.slice(1)} | ${total[k].pct}% | ${total[k].covered} / ${total[k].total} |`,
);
console.log(["## Coverage", "", "| | % | Covered |", "|---|---:|---:|", ...rows].join("\n"));
