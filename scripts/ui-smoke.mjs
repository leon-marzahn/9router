#!/usr/bin/env node
// Browser smoke test: visit every dashboard route on a demo-seeded throwaway
// instance (same boot as scripts/pr-shots.mjs) and fail on UI regressions.
//
//   node scripts/ui-smoke.mjs [--out ui-smoke] [--routes /dashboard/usage,...] [--update-baseline]
//   bun run smoke
//
// Each route is checked at desktop 1440x900 and mobile 375x812 (touch phone
// emulation), light theme; a few routes also in dark. Checks:
//   overflow  document scrolls horizontally (scrollWidth > clientWidth); the
//             elements sticking out past the viewport are listed in the report
//   console   console.error / uncaught exceptions
//   http      same-origin responses with status >= 400 (ALLOWED_HTTP lists expected ones)
//   tap       mobile: interactive elements smaller than 40x40 px (inline text links excepted)
//   axe       axe-core violations of serious/critical impact (axe-core pinned in package.json)
//
// Known issues live in scripts/ui-smoke/baseline.txt, one `check | viewport | route | detail`
// per line (`*` matches any field, `# ...` is a comment). Only issues not in the
// baseline fail the run; baseline lines that no longer match are reported as
// fixed so they can be deleted. Same idea as tests/__baseline__/known-fails.txt:
// keep it shrinking. `--update-baseline` rewrites it from the current findings.
//
// Writes <out>/report.md (also appended to $GITHUB_STEP_SUMMARY) and a
// screenshot per route/viewport/theme to <out>/.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { root, settle, startInstance, VIEWPORTS } from "./pr-shots/instance.mjs";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "ui-smoke" },
    routes: { type: "string" },
    "update-baseline": { type: "boolean", default: false },
    port: { type: "string" },
  },
});

const BASELINE = join(root, "scripts/ui-smoke/baseline.txt");
const DARK_ROUTES = ["/dashboard/endpoint", "/dashboard/providers", "/dashboard/usage"];
const MIN_TAP = 40;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/** Expected non-2xx same-origin responses. Each needs a reason. */
const ALLOWED_HTTP = [
  {
    match: /^GET \/api\/usage\/demo-conn-[\w-]+ 503$/,
    reason: "mocks.json catch-all: quota lookups for seeded accounts are stubbed to 503",
  },
  {
    match: /^GET \/api\/providers\/demo-conn-[\w-]+\/models 503$/,
    reason: "mocks.json: model lists for seeded (fake-key) accounts are stubbed to 503",
  },
];

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });
const routes = args.routes ? args.routes.split(",").map((r) => r.trim()) : discoverRoutes();

const instance = await startInstance({ port: Number(args.port) || undefined });
const { base } = instance;
/** @type {{ check: string, viewport: string, route: string, detail: string, extra?: string }[]} */
const issues = [];
const visited = [];
const started = Date.now();
try {
  const runs = [];
  for (const [vp] of VIEWPORTS) runs.push({ vp, theme: "light", routes });
  runs.push({
    vp: "desktop",
    theme: "dark",
    routes: routes.filter((r) => DARK_ROUTES.includes(r)),
  });
  for (const { vp, theme, routes: list } of runs) {
    const context = await instance.newContext(vp, theme);
    // Keep runs hermetic: only same-origin and font requests leave the browser
    // (the dashboard loads analytics, which also differs between CI and laptops).
    await context.route(
      (url) => url.origin !== base && !FONT_HOSTS.includes(url.hostname),
      (r) => r.abort("blockedbyclient"),
    );
    const page = await context.newPage();
    const viewport = theme === "light" ? vp : `${vp}-dark`;
    let current = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (text.startsWith("Failed to load resource")) {
        // Same-origin failures are reported (and allow-listed) by the http check.
        const url = msg.location().url || "";
        if (url.startsWith(base) || /ERR_BLOCKED_BY_CLIENT/.test(text)) return;
        current.push({ check: "console", detail: `${text} (${url.replace(/[?#].*/, "")})` });
        return;
      }
      // Next dev wraps server-forwarded logs as "%c%s%c <msg> <css>"; keep the message.
      const clean = text.startsWith("%c")
        ? text.replace(/%[cs]/g, "").replace(/\s*background:.*$/s, "")
        : text;
      current.push({ check: "console", detail: clean.trim() });
    });
    page.on("requestfailed", (req) => {
      const url = new URL(req.url());
      if (url.origin !== base) return;
      // Navigating away aborts in-flight requests (SSE, polling); that is not a bug.
      if (req.failure()?.errorText === "net::ERR_ABORTED") return;
      current.push({
        check: "http",
        detail: `${req.method()} ${url.pathname} ${req.failure()?.errorText}`,
        raw: true,
      });
    });
    page.on("pageerror", (err) =>
      current.push({ check: "console", detail: `uncaught: ${err.message}` }),
    );
    page.on("response", (res) => {
      const url = new URL(res.url());
      if (url.origin !== base || res.status() < 400) return;
      const sig = `${res.request().method()} ${url.pathname} ${res.status()}`;
      if (ALLOWED_HTTP.some((a) => a.match.test(sig))) return;
      current.push({ check: "http", detail: sig, raw: true });
    });
    for (const route of list) {
      current = [];
      const t0 = Date.now();
      try {
        await page.goto(base + route, { waitUntil: "load", timeout: 180_000 });
        await settle(page);
        current.push(...(await checkPage(page, vp)));
      } catch (e) {
        current.push({ check: "load", detail: e.message.split("\n")[0] });
      }
      const file = `${slug(route)}-${viewport}.png`;
      await page.screenshot({ path: join(outDir, file), fullPage: true }).catch(() => {});
      for (const { raw, ...i } of current)
        issues.push({ viewport, route, ...i, detail: raw ? i.detail : norm(i.detail) });
      visited.push({ route, viewport, ms: Date.now() - t0 });
      console.log(
        `${viewport.padEnd(12)} ${route}  ${current.length} finding(s)  ${Date.now() - t0}ms`,
      );
    }
    await context.close();
  }
} finally {
  await instance.stop();
}

// Dedupe, then split into baselined and new.
const seen = new Set();
const unique = issues.filter((i) => {
  const k = key(i);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
if (args["update-baseline"]) {
  const lines = unique.map((i) => `${key(i)}  # TODO: ${todo(i.check)}`).sort();
  writeFileSync(BASELINE, `${readHeader()}${lines.join("\n")}\n`);
  console.log(`wrote ${lines.length} entries to ${BASELINE}`);
}
const baseline = readBaseline();
const fresh = unique.filter((i) => !baseline.some((b) => matches(b, i)));
const stale = baseline.filter((b) => !unique.some((i) => matches(b, i)));

const report = renderReport();
writeFileSync(join(outDir, "report.md"), report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(`\n${report}`);
process.exit(fresh.length ? 1 : 0);

// ---------------------------------------------------------------------------

async function checkPage(page, vp) {
  const found = await page.evaluate(
    ({ mobile, minTap }) => {
      const out = [];
      const describe = (el) => {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${el.id}`;
        const label =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        return label ? `${tag} "${label}"` : `${tag}.${[...el.classList].slice(0, 2).join(".")}`;
      };
      const visible = (el) => {
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0)
          return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // Inside a scroll/clip container, sticking out is the container's business.
      const clipped = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
        }
        return false;
      };

      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) {
        const vw = doc.clientWidth;
        const culprits = [...document.body.querySelectorAll("*")]
          .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1 && !clipped(el))
          // Keep the outermost offenders only.
          .filter((el, _, all) => !all.includes(el.parentElement))
          .slice(0, 5)
          .map((el) => `${describe(el)} right=${Math.round(el.getBoundingClientRect().right)}`);
        out.push({
          check: "overflow",
          detail: `page scrolls horizontally`,
          extra: `scrollWidth ${doc.scrollWidth} > ${vw}; ${culprits.join(", ") || "no single culprit"}`,
        });
      }

      // The app shell scrolls inside a full-width container, so the document can
      // stay put while the page content still overflows sideways.
      for (const el of document.querySelectorAll("main, [data-scroll-root], body *")) {
        if (el === doc || !visible(el)) continue;
        if (el.clientWidth < doc.clientWidth * 0.9) continue;
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
        out.push({
          check: "overflow",
          detail: `container ${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")} scrolls horizontally`,
          extra: `scrollWidth ${el.scrollWidth} > ${el.clientWidth}`,
        });
        break;
      }

      if (mobile) {
        const sel =
          'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=radio], [tabindex]:not([tabindex="-1"])';
        for (const el of document.querySelectorAll(sel)) {
          if (!visible(el) || el.closest("nextjs-portal")) continue;
          if (el.disabled || el.getAttribute("aria-hidden") === "true") continue;
          // Inline text links inside running text are exempt (WCAG 2.5.8 "inline").
          if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
          // Visually hidden inputs styled through their label: measure the label.
          let target = el;
          if (el.tagName === "INPUT" && el.getBoundingClientRect().width <= 1) {
            target = el.closest("label") || el;
          }
          const r = target.getBoundingClientRect();
          if (r.width < minTap || r.height < minTap) {
            out.push({
              check: "tap",
              detail: describe(el),
              extra: `${Math.round(r.width)}x${Math.round(r.height)}`,
            });
          }
        }
      }
      return out;
    },
    { mobile: vp === "mobile", minTap: MIN_TAP },
  );

  await page.addScriptTag({ path: join(root, "node_modules/axe-core/axe.min.js") });
  const axe = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const res = await window.axe.run(document, {
      resultTypes: ["violations"],
      exclude: [["nextjs-portal"]],
    });
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        check: "axe",
        detail: v.id,
        extra: `${v.impact}, ${v.nodes.length} node(s): ${v.help}; e.g. ${v.nodes
          .slice(0, 2)
          .map((n) => n.target.join(" "))
          .join(" | ")}`,
      }));
  });
  return [...found, ...axe];
}

/** Dashboard routes: nav items, every static page under the app dir, plus key states. */
function discoverRoutes() {
  const nav = readFileSync(join(root, "src/ui/frame/nav.ts"), "utf8");
  const set = new Set([...nav.matchAll(/"(\/dashboard[\w\-/]*)"/g)].map((m) => m[1]));
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) {
        if (/^page\.(js|jsx|ts|tsx)$/.test(e.name)) set.add(prefix || "/");
        continue;
      }
      if (e.name.startsWith("[") || e.name.startsWith("_") || e.name === "api") continue;
      // Route groups `(name)` don't add a path segment.
      walk(join(dir, e.name), e.name.startsWith("(") ? prefix : `${prefix}/${e.name}`);
    }
  };
  walk(join(root, "src/app"), "");
  for (const r of set) {
    if (!r.startsWith("/dashboard") && !r.startsWith("/customer")) set.delete(r);
  }
  // Workbench overview states and representative dynamic pages.
  for (const r of [
    "/dashboard/providers?view=overview",
    "/dashboard/combos?view=overview",
    "/dashboard/proxy-pools?view=overview",
    "/dashboard/request-pipelines?view=overview",
    "/dashboard/providers/openai",
    "/dashboard/cli-tools/claude",
  ])
    set.add(r);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function key(i) {
  return `${i.check} | ${i.viewport} | ${i.route} | ${i.detail}`;
}

/** Strip volatile bits (numbers, hashes, ports) so findings are stable across runs. */
function norm(s) {
  return String(s)
    .replace(/https?:\/\/localhost:\d+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[|#]/g, "/")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 160);
}

function slug(route) {
  return route.replace(/^\/|\/$/g, "").replace(/[^\w.-]+/g, "-") || "root";
}

function todo(check) {
  return {
    overflow: "fix horizontal overflow",
    console: "fix console error",
    http: "fix failing request",
    tap: "enlarge tap target to 40px",
    axe: "fix accessibility violation",
    load: "fix page load",
  }[check];
}

function readHeader() {
  if (!existsSync(BASELINE)) return "";
  const lines = readFileSync(BASELINE, "utf8").split("\n");
  const head = [];
  for (const l of lines) {
    if (!l.startsWith("#")) break;
    head.push(l);
  }
  return head.length ? `${head.join("\n")}\n` : "";
}

function readBaseline() {
  if (!existsSync(BASELINE)) return [];
  return readFileSync(BASELINE, "utf8")
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [check, viewport, route, ...rest] = l.split("|").map((x) => x.trim());
      return { line: l, check, viewport, route, detail: rest.join("|").trim() };
    });
}

function matches(b, i) {
  return ["check", "viewport", "route", "detail"].every((f) => b[f] === "*" || b[f] === i[f]);
}

function renderReport() {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/</g, "&lt;");
  const secs = Math.round((Date.now() - started) / 1000);
  const lines = [
    `## UI smoke ${fresh.length ? "failed" : "passed"}`,
    "",
    `${visited.length} page visits (${routes.length} routes) in ${secs}s. ` +
      `${unique.length} finding(s): **${fresh.length} new**, ${unique.length - fresh.length} known (scripts/ui-smoke/baseline.txt).`,
    "",
  ];
  if (fresh.length) {
    lines.push(
      "### New issues",
      "",
      "| Route | Viewport | Check | Issue | Details |",
      "|---|---|---|---|---|",
    );
    for (const i of fresh.sort((a, b) => key(a).localeCompare(key(b))))
      lines.push(
        `| \`${i.route}\` | ${i.viewport} | ${i.check} | ${esc(i.detail)} | ${esc(i.extra ?? "")} |`,
      );
    lines.push(
      "",
      "Fix them, or if one is expected add it to `ALLOWED_HTTP` (with a reason) / `scripts/ui-smoke/baseline.txt` (with a TODO).",
      "",
    );
  }
  if (stale.length) {
    lines.push("### Fixed (delete from baseline)", "");
    for (const b of stale) lines.push(`- \`${b.line}\``);
    lines.push("");
  }
  const known = unique.filter((i) => !fresh.includes(i));
  if (known.length) {
    lines.push("<details><summary>Known issues (baseline)</summary>", "");
    lines.push("| Route | Viewport | Check | Issue | Details |", "|---|---|---|---|---|");
    for (const i of known)
      lines.push(
        `| \`${i.route}\` | ${i.viewport} | ${i.check} | ${esc(i.detail)} | ${esc(i.extra ?? "")} |`,
      );
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}
