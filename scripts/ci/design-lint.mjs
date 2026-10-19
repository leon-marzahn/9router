#!/usr/bin/env node
// Design-system lint for the redesigned UI (docs/DESIGN.md "Lint rules").
// Oxlint covers the import rule (`no-restricted-imports` in vite.config.ts);
// this script covers what Oxlint can't express without a JS plugin:
//   raw-control  <button>/<input>/<select>/<textarea> JSX outside src/ui
//   raw-color    hex / rgb() / hsl() literals, Tailwind arbitrary colors
//                (bg-[#…]) and Tailwind palette colors (bg-red-500) instead
//                of the tokens in src/app/globals.css
// Scope: TS/TSX under src/ui and src/app (fork-owned UI) plus CSS there,
// except globals.css, which defines the tokens.
//
// Existing violations are counted per file in scripts/ci/design-lint-baseline.txt;
// a file fails only when it has more than its baseline count.
//   node scripts/ci/design-lint.mjs                    check (CI)
//   node scripts/ci/design-lint.mjs --update-baseline  rewrite the baseline
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

const ROOT = join(import.meta.dirname, "../..");
const BASELINE = join(import.meta.dirname, "design-lint-baseline.txt");
const SCOPES = ["src/ui", "src/app"];
const TOKEN_FILES = new Set(["src/app/globals.css"]);
const RAW_CONTROLS = new Set(["button", "input", "select", "textarea"]);

const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white";
const UTIL =
  "bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|outline|divide|shadow|decoration|accent|caret|placeholder";
const COLOR_PATTERNS = [
  ["hex", /(?<![\w&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g],
  ["color function", /\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/g],
  [
    "Tailwind palette",
    new RegExp(`(?<![\\w-])(?:${UTIL})-(?:${PALETTE})(?:-\\d{2,3})?(?:\\/\\d+)?(?![\\w-])`, "g"),
  ],
];

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (/\.(tsx?|css)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function colorHits(text, line, push) {
  for (const [kind, re] of COLOR_PATTERNS) {
    for (const m of text.matchAll(re)) push("raw-color", line, `${kind} \`${m[0]}\``);
  }
}

function lintFile(rel, src) {
  const hits = [];
  const push = (rule, line, msg) => hits.push({ rule, line, msg });
  if (rel.endsWith(".css")) {
    src.split("\n").forEach((l, i) => colorHits(l.replace(/\/\*.*?\*\//g, ""), i + 1, push));
    return hits;
  }
  const ast = parse(src, {
    sourceType: "module",
    plugins: rel.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    errorRecovery: true,
  });
  const inUi = rel.startsWith("src/ui/");
  (function visit(node) {
    if (!node || typeof node.type !== "string") return;
    if (
      node.type === "JSXOpeningElement" &&
      !inUi &&
      node.name.type === "JSXIdentifier" &&
      RAW_CONTROLS.has(node.name.name)
    ) {
      push("raw-control", node.loc.start.line, `raw <${node.name.name}>: use the src/ui component`);
    }
    if (node.type === "StringLiteral") colorHits(node.value, node.loc.start.line, push);
    if (node.type === "TemplateElement") colorHits(node.value.raw, node.loc.start.line, push);
    if (node.type === "JSXText") colorHits(node.value, node.loc.start.line, push);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") visit(v);
    }
  })(ast.program);
  return hits;
}

const results = new Map(); // "rule :: file" -> hits[]
for (const scope of SCOPES) {
  for (const abs of walkFiles(join(ROOT, scope))) {
    const rel = relative(ROOT, abs).split("\\").join("/");
    if (TOKEN_FILES.has(rel)) continue;
    for (const h of lintFile(rel, readFileSync(abs, "utf8"))) {
      const key = `${h.rule} :: ${rel}`;
      if (!results.has(key)) results.set(key, []);
      results.get(key).push(h);
    }
  }
}

const counts = [...results].map(([k, v]) => [k, v.length]).sort(([a], [b]) => a.localeCompare(b));
const totals = {};
for (const [k, n] of counts) totals[k.split(" :: ")[0]] = (totals[k.split(" :: ")[0]] ?? 0) + n;

if (process.argv.includes("--update-baseline")) {
  const header =
    "# Design-lint baseline: pre-existing violations, `rule :: file :: count`.\n" +
    "# Regenerate with `node scripts/ci/design-lint.mjs --update-baseline`; only ever shrink it.\n";
  writeFileSync(BASELINE, header + counts.map(([k, n]) => `${k} :: ${n}`).join("\n") + "\n");
  console.log(`Baseline written: ${JSON.stringify(totals)}`);
  process.exit(0);
}

const baseline = new Map();
if (existsSync(BASELINE)) {
  for (const line of readFileSync(BASELINE, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" :: ");
    baseline.set(line.slice(0, i), Number(line.slice(i + 4)));
  }
}

let failed = 0;
for (const [key, hits] of results) {
  const allowed = baseline.get(key) ?? 0;
  if (hits.length <= allowed) continue;
  failed++;
  const [rule, file] = key.split(" :: ");
  console.error(`\n${file}: ${hits.length} ${rule} violation(s), baseline allows ${allowed}`);
  for (const h of hits) console.error(`  ${file}:${h.line}  ${h.msg}`);
}
const shrunk = [...baseline].filter(([k, n]) => (results.get(k)?.length ?? 0) < n);
if (shrunk.length) {
  console.log(
    `${shrunk.length} baseline entr${shrunk.length === 1 ? "y is" : "ies are"} above the current count; run with --update-baseline to lock in the fix.`,
  );
}
console.log(`design-lint: ${JSON.stringify(totals)} (baseline ${baseline.size} file/rule entries)`);
if (failed) {
  console.error(
    `\ndesign-lint failed: new violations in ${failed} file/rule pair(s). Use src/ui components and tokens (docs/DESIGN.md).`,
  );
  process.exit(1);
}
