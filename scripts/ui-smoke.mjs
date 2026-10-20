#!/usr/bin/env node
// Browser smoke test: visit every dashboard route, and open the key UI states
// (dialogs, drawers, menus) from scripts/ui-smoke/states.json, on a demo-seeded
// throwaway instance (same boot as scripts/pr-shots.mjs) and fail on UI regressions.
//
//   node scripts/ui-smoke.mjs [--out ui-smoke] [--routes /dashboard/usage,...] [--states a,b]
//                             [--changed <git-ref>] [--concurrency 4] [--dev] [--update-baseline]
//   bun run smoke
//
// Each route and state is checked at desktop 1440x900 and mobile 375x812 (touch
// phone emulation), light theme; a few routes also in dark. Checks:
//   overflow  document scrolls horizontally (scrollWidth > clientWidth); the
//             elements sticking out past the viewport are listed in the report.
//             In a state with a `selector`, also anything in it that sticks out
//             of it or past the viewport, and the state's own scroll containers
//   console   console.error / uncaught exceptions
//   http      same-origin responses with status >= 400 (ALLOWED_HTTP lists expected ones)
//   tap       mobile: interactive elements smaller than 40x40 px (inline text links excepted)
//   axe       axe-core violations of serious/critical impact (axe-core pinned in package.json)
//   state     a state's step failed (selector not found, ...)
// In a state with a `selector`, tap and axe only look inside it (the page behind
// it is covered by its route).
//
// States use the pr-shots `--shots` format (see scripts/pr-shots.mjs): `name`,
// `route`, `steps` (click/fill/select/hover/press/waitFor/wait), optional
// `selector`, `viewports`, `mocks`. A PR that adds a dialog, drawer or menu adds
// its state there.
//
// --changed <ref> checks only what the diff <ref>..HEAD can affect (see
// scripts/ui-smoke/affected.mjs); CI does that on pull requests and a full run on
// master. --concurrency runs that many pages in parallel (default 4, 1 with --dev).
// It smokes a production build (`next build` into .next-smoke, then custom-server.js);
// --dev (or SMOKE_MODE=dev) uses `next dev` instead (no build, but each route
// compiles on first visit and live reloads open pages, so it visits one at a time).
//
// Known issues live in scripts/ui-smoke/baseline.txt, one `check | viewport | route | detail`
// per line (`*` matches any field, `# ...` is a comment, a trailing ` @dev`/` @prod`
// limits a line to that server mode); a state's route is
// `state:<name>`. Only issues not in the baseline fail the run; baseline lines
// that no longer match (among what this run visited) are reported as fixed so
// they can be deleted. Same idea as tests/__baseline__/known-fails.txt: keep it
// shrinking. `--update-baseline` rewrites it from the current findings (full runs only).
//
// Writes <out>/report.md (also appended to $GITHUB_STEP_SUMMARY) and a
// screenshot per route/state, viewport and theme to <out>/.
import { execFileSync } from "node:child_process";
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
import {
  applyMocks,
  root,
  runStep,
  settle,
  startInstance,
  VIEWPORTS,
} from "./pr-shots/instance.mjs";
import { affectedSections, routeSelected } from "./ui-smoke/affected.mjs";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "ui-smoke" },
    routes: { type: "string" },
    states: { type: "string" },
    changed: { type: "string" },
    concurrency: { type: "string" },
    dev: { type: "boolean", default: false },
    "update-baseline": { type: "boolean", default: false },
    port: { type: "string" },
  },
});

const BASELINE = join(root, "scripts/ui-smoke/baseline.txt");
const STATES_FILE = join(root, "scripts/ui-smoke/states.json");
const DARK_ROUTES = ["/dashboard/endpoint", "/dashboard/providers", "/dashboard/usage"];
const MIN_TAP = 40;
/** Set on a state's `selector` element by openState(). */
const SCOPE = "[data-smoke-scope]";
/** `route#state` entries that need sessionStorage set before load (demo key from seed.mjs). */
const SESSION_STATES = {
  "/customer#signed-in": ["regent.customerKey", "sk-regent-demo-laptop-0000000000"],
};
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
const allStates = loadStates();
let routes = args.routes
  ? args.routes.split(",").map((r) => r.trim())
  : args.states
    ? []
    : discoverRoutes();
let states = args.states
  ? allStates.filter((s) => args.states.split(",").includes(s.name))
  : args.routes
    ? []
    : allStates;
let scope = args.routes || args.states ? "picked by --routes/--states" : "full run";
if (args.changed && !args.routes && !args.states) {
  const hit = affectedSections(changedFiles(args.changed), appSources());
  if (hit.full) scope = `full run (${hit.reason} changed)`;
  else {
    routes = routes.filter((r) => routeSelected(r, hit.sections));
    states = states.filter((s) => routeSelected(s.route, hit.sections));
    scope = `changed since ${args.changed}: ${hit.sections.join(", ") || "no page dirs"}, plus core routes`;
  }
}
const partial = !scope.startsWith("full run");
console.log(`ui-smoke: ${routes.length} routes, ${states.length} states; ${scope}`);

const started = Date.now();
const instance = await startInstance({
  port: Number(args.port) || undefined,
  // A production build boots slower but then serves every page at once; under
  // `next dev` per-route compiles and live reloads make parallel visits flaky.
  mode: args.dev || process.env.SMOKE_MODE === "dev" ? "dev" : "prod",
});
const { base } = instance;
if (instance.mode === "dev") await prewarm();
const bootSecs = Math.round((Date.now() - started) / 1000);
/** @type {{ check: string, viewport: string, route: string, detail: string, extra?: string }[]} */
const issues = [];
const visited = [];
try {
  // One job per page visit. Workers pull from the queue, each with its own page
  // per viewport/theme; findings are sorted afterwards, so the report does not
  // depend on scheduling.
  const jobs = [];
  for (const [vp] of VIEWPORTS) {
    for (const route of routes) jobs.push({ vp, theme: "light", route });
    for (const state of states)
      if (!state.viewports || state.viewports.includes(vp))
        jobs.push({ vp, theme: "light", route: `state:${state.name}`, state });
  }
  for (const route of routes.filter((r) => DARK_ROUTES.includes(r)))
    jobs.push({ vp: "desktop", theme: "dark", route });
  const wanted = Number(args.concurrency) || (instance.mode === "dev" ? 1 : 4);
  const workers = Math.max(1, Math.min(wanted, jobs.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const pages = new Map();
      try {
        while (next < jobs.length) {
          const job = jobs[next++];
          if (job.state?.mocks) {
            // A state's own mocks stick to its context, so it gets a fresh one.
            const p = await openPage(job.vp, job.theme);
            await applyMocks(p.page.context(), job.state.mocks);
            await visit(p, job);
            await p.page.context().close();
            continue;
          }
          const k = `${job.vp}-${job.theme}`;
          if (!pages.has(k)) pages.set(k, await openPage(job.vp, job.theme));
          await visit(pages.get(k), job);
        }
      } finally {
        for (const p of pages.values()) await p.page.context().close();
      }
    }),
  );
} finally {
  await instance.stop();
}

// Dedupe, then split into baselined and new.
const seen = new Set();
const unique = issues
  .filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => key(a).localeCompare(key(b)));
if (args["update-baseline"]) {
  if (partial) throw new Error("--update-baseline needs a full run (drop --changed)");
  // Lines scoped to the other server mode can't be judged by this run: keep them.
  const other = existsSync(BASELINE)
    ? readFileSync(BASELINE, "utf8")
        .split("\n")
        .filter((l) => /\s@(dev|prod)(\s|$)/.test(l) && !l.includes(` @${instance.mode}`))
    : [];
  const lines = [...unique.map((i) => `${key(i)}  # TODO: ${todo(i.check)}`), ...other].sort(
    (a, b) => a.localeCompare(b),
  );
  writeFileSync(BASELINE, `${readHeader()}${lines.join("\n")}\n`);
  console.log(`wrote ${lines.length} entries to ${BASELINE}`);
}
const baseline = readBaseline();
const fresh = unique.filter((i) => !baseline.some((b) => matches(b, i)));
const ran = new Set(visited.map((v) => `${v.viewport} | ${v.route}`));
// Only claim a line is fixed when this run fully covered it: a clean full run
// for wildcard lines, the exact route/viewport otherwise, and never on a failing run.
const stale = fresh.length
  ? []
  : baseline.filter(
      (b) =>
        ((b.viewport === "*" || b.route === "*") && !partial
          ? true
          : ran.has(`${b.viewport} | ${b.route}`)) && !unique.some((i) => matches(b, i)),
    );

const report = renderReport();
writeFileSync(join(outDir, "report.md"), report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(`\n${report}`);
process.exit(fresh.length ? 1 : 0);

// ---------------------------------------------------------------------------

async function openPage(vp, theme) {
  const context = await instance.newContext(vp, theme);
  // Keep runs hermetic: only same-origin and font requests leave the browser
  // (the dashboard loads analytics, which also differs between CI and laptops).
  await context.route(
    (url) => url.origin !== base && !FONT_HOSTS.includes(url.hostname),
    (r) => r.abort("blockedbyclient"),
  );
  // Seed sessionStorage before any page script runs, keyed on `path#state`
  // (the hash never reaches the server); every other route starts clean.
  await context.addInitScript((states) => {
    if (location.protocol === "about:") return;
    const entry = states[location.pathname + location.hash];
    for (const [k] of Object.values(states)) sessionStorage.removeItem(k);
    if (entry) sessionStorage.setItem(entry[0], entry[1]);
  }, SESSION_STATES);
  const page = await context.newPage();
  // Findings of the visit in progress on this page (one visit at a time per page).
  const sink = { current: [] };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.startsWith("Failed to load resource")) {
      // Same-origin failures are reported (and allow-listed) by the http check.
      const url = msg.location().url || "";
      if (url.startsWith(base) || /ERR_BLOCKED_BY_CLIENT/.test(text)) return;
      sink.current.push({ check: "console", detail: `${text} (${url.replace(/[?#].*/, "")})` });
      return;
    }
    // Next dev wraps server-forwarded logs as "%c%s%c <msg> <css>"; keep the message.
    const clean = text.startsWith("%c")
      ? text.replace(/%[cs]/g, "").replace(/\s*background:.*$/s, "")
      : text;
    sink.current.push({ check: "console", detail: clean.trim() });
  });
  page.on("requestfailed", (req) => {
    const url = new URL(req.url());
    if (url.origin !== base) return;
    // Navigating away aborts in-flight requests (SSE, polling); that is not a bug.
    if (req.failure()?.errorText === "net::ERR_ABORTED") return;
    sink.current.push({
      check: "http",
      detail: `${req.method()} ${url.pathname} ${req.failure()?.errorText}`,
      raw: true,
    });
  });
  page.on("pageerror", (err) =>
    sink.current.push({ check: "console", detail: `uncaught: ${err.message}` }),
  );
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.origin !== base || res.status() < 400) return;
    const sig = `${res.request().method()} ${url.pathname} ${res.status()}`;
    if (ALLOWED_HTTP.some((a) => a.match.test(sig))) return;
    sink.current.push({ check: "http", detail: sig, raw: true });
  });
  return { page, sink };
}

/**
 * `next dev` compiles a route on its first request and then live-reloads every
 * open page, which aborts parallel visits. Compile them all up front, a few at a
 * time, before any browser page is open.
 */
async function prewarm() {
  const t0 = Date.now();
  const paths = [
    ...new Set([...routes, ...states.map((s) => s.route)].map((r) => r.replace(/[?#].*$/, ""))),
  ];
  const ctx = await instance.newContext("desktop");
  let i = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (i < paths.length) {
        const p = paths[i++];
        await ctx.request.get(base + p, { timeout: 180_000 }).catch(() => {});
      }
    }),
  );
  await ctx.close();
  console.log(`prewarmed ${paths.length} routes in ${Math.round((Date.now() - t0) / 1000)}s`);
}

async function visit(p, job, retried = false) {
  const { page, sink } = p;
  const { vp, theme, route, state } = job;
  const viewport = theme === "light" ? vp : `${vp}-dark`;
  const current = [];
  sink.current = current;
  const t0 = Date.now();
  const url = state ? state.route : route;
  try {
    // A hash-only change would be a same-document navigation (no init script),
    // and a state must start from a fresh load: leave the previous page first.
    if (url.includes("#") || state) await page.goto("about:blank");
    await page.goto(base + url, { waitUntil: "load", timeout: 180_000 });
    await settle(page);
    if (state) await openState(page, state, vp);
    current.push(...(await checkPage(page, vp, state?.selector ? SCOPE : null)));
  } catch (e) {
    // A dev-server reload (late compile, HMR) can abort a visit; try once more.
    if (
      !retried &&
      /ERR_ABORTED|context was destroyed|interrupted by another navigation/.test(e.message)
    ) {
      await page.waitForTimeout(2_000);
      sink.current = [];
      console.log(`retrying ${route} (${viewport}): ${e.message.split("\n")[0]}`);
      return visit(p, job, true);
    }
    const isState = e.cause === "state";
    current.push({
      check: isState ? "state" : "load",
      detail: isState ? norm(e.message) : e.message.split("\n")[0],
    });
  }
  sink.current = [];
  const file = `${slug(route)}-${viewport}.png`;
  await page.screenshot({ path: join(outDir, file), fullPage: !state }).catch(() => {});
  for (const { raw, ...i } of current)
    issues.push({ viewport, route, ...i, detail: raw ? i.detail : norm(i.detail) });
  visited.push({ route, viewport, ms: Date.now() - t0 });
  console.log(
    `${viewport.padEnd(12)} ${route}  ${current.length} finding(s)  ${Date.now() - t0}ms`,
  );
}

async function openState(page, state, vp) {
  // Clicking before hydration does nothing: wait out the page's own loading
  // (longer than settle(), which gives up after 5s on pages that keep polling).
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  for (const step of state.steps ?? []) {
    try {
      await runStep(page, step, vp);
    } catch (e) {
      throw new Error(`step ${JSON.stringify(step)} failed: ${e.message.split("\n")[0]}`, {
        cause: "state",
      });
    }
  }
  if (state.selector) {
    // Mark it, so the in-page checks and axe can find it with plain CSS
    // (state selectors may use Playwright syntax like :has-text()).
    await page
      .locator(state.selector)
      .first()
      .evaluate((el) => el.setAttribute("data-smoke-scope", ""), null, { timeout: 15_000 })
      .catch((e) => {
        throw new Error(`selector ${state.selector} not found: ${e.message.split("\n")[0]}`, {
          cause: "state",
        });
      });
  }
  // Let open animations finish (reducedMotion is on, but some use JS timers).
  await page.waitForTimeout(400);
}

async function checkPage(page, vp, selector) {
  const found = await page.evaluate(
    ({ mobile, minTap, selector }) => {
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
      // Inside a scroll/clip container (below `stop`), sticking out is the container's business.
      const clipped = (el, stop = document.body) => {
        for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
        }
        return false;
      };

      // Effective hit area: the box grown by absolutely positioned ::before/::after
      // overlays (e.g. src/ui/Switch's invisible `after:-inset-*` tap area).
      const hitArea = (el) => {
        const b = el.getBoundingClientRect();
        let { left, top, right, bottom } = b;
        for (const pseudo of ["::before", "::after"]) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === "none" || ps.display === "none" || ps.position !== "absolute")
            continue;
          const px = (v) => (v === "auto" ? null : parseFloat(v));
          const [l, t, r, bt] = [px(ps.left), px(ps.top), px(ps.right), px(ps.bottom)];
          if (l !== null) left = Math.min(left, b.left + l);
          if (t !== null) top = Math.min(top, b.top + t);
          if (r !== null) right = Math.max(right, b.right - r);
          if (bt !== null) bottom = Math.max(bottom, b.bottom - bt);
        }
        return { width: right - left, height: bottom - top };
      };

      const doc = document.documentElement;
      const vw = doc.clientWidth;
      if (doc.scrollWidth > vw) {
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

      // A state (dialog, drawer, menu) is usually position:fixed, which never
      // widens the document: check that it fits the viewport and that nothing in
      // it sticks out of it or scrolls sideways.
      const scope = selector ? document.querySelector(selector) : null;
      if (scope) {
        const box = scope.getBoundingClientRect();
        const wide = box.left < -1 || box.right > vw + 1;
        if (wide) {
          out.push({
            check: "overflow",
            detail: `state wider than the viewport`,
            extra: `left=${Math.round(box.left)} right=${Math.round(box.right)} viewport ${vw}`,
          });
        }
        const right = Math.min(box.right, vw);
        const culprits = (wide ? [] : [...scope.querySelectorAll("*")])
          .filter((el) => {
            if (!visible(el) || clipped(el, scope)) return false;
            const r = el.getBoundingClientRect();
            return r.right > right + 1 || r.left < Math.max(box.left, 0) - 1;
          })
          .filter((el, _, all) => !all.includes(el.parentElement))
          .slice(0, 5);
        if (culprits.length) {
          out.push({
            check: "overflow",
            detail: `content sticks out of the state: ${describe(culprits[0])}`,
            extra: culprits
              .map((el) => `${describe(el)} right=${Math.round(el.getBoundingClientRect().right)}`)
              .join(", "),
          });
        }
        for (const el of [scope, ...scope.querySelectorAll("*")]) {
          if (!visible(el) || el.scrollWidth <= el.clientWidth + 1) continue;
          if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
          // Only containers about as wide as the state: a deliberately scrolling
          // code block or table inside it is fine.
          if (el.clientWidth < box.width * 0.9) continue;
          out.push({
            check: "overflow",
            detail: `${describe(el).slice(0, 40)} in the state scrolls horizontally`,
            extra: `scrollWidth ${el.scrollWidth} > ${el.clientWidth}`,
          });
          break;
        }
      }

      // The app shell scrolls inside a full-width container, so the document can
      // stay put while the page content still overflows sideways.
      for (const el of document.querySelectorAll("main, [data-scroll-root], body *")) {
        if (el === doc || !visible(el) || scope?.contains(el)) continue;
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
        for (const el of (scope || document).querySelectorAll(sel)) {
          if (!visible(el) || el.closest("nextjs-portal")) continue;
          if (el.disabled || el.getAttribute("aria-hidden") === "true") continue;
          // Inline text links inside running text are exempt (WCAG 2.5.8 "inline").
          if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
          // Visually hidden inputs styled through their label: measure the label.
          let target = el;
          if (el.tagName === "INPUT" && el.getBoundingClientRect().width <= 1) {
            target = el.closest("label") || el;
          }
          const r = hitArea(target);
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
    { mobile: vp === "mobile", minTap: MIN_TAP, selector: selector ?? null },
  );

  await page.addScriptTag({ path: join(root, "node_modules/axe-core/axe.min.js") });
  const axe = await page.evaluate(async (selector) => {
    // eslint-disable-next-line no-undef
    const res = await window.axe.run(
      selector ? { include: [[selector]], exclude: [["nextjs-portal"]] } : document,
      selector
        ? { resultTypes: ["violations"] }
        : { resultTypes: ["violations"], exclude: [["nextjs-portal"]] },
    );
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
  }, selector ?? null);
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
    ...Object.keys(SESSION_STATES),
  ])
    set.add(r);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function loadStates() {
  const list = JSON.parse(readFileSync(STATES_FILE, "utf8"));
  const names = new Set();
  for (const s of list) {
    if (!/^[\w-]+$/.test(s.name ?? "")) throw new Error(`state needs a plain "name": ${s.name}`);
    if (names.has(s.name)) throw new Error(`duplicate state name ${s.name}`);
    names.add(s.name);
    if (!/^\/[\w\-/]*(\?[\w=&-]*)?(#[\w-]+)?$/.test(s.route ?? ""))
      throw new Error(`state "${s.name}" needs a plain "route"`);
  }
  return list;
}

/** Files changed between `ref` (via merge-base) and HEAD. */
function changedFiles(ref) {
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  let from = ref;
  try {
    from = git("merge-base", ref, "HEAD");
  } catch {}
  return git("diff", "--name-only", from, "HEAD").split("\n").filter(Boolean);
}

/** Code of the page and shared-UI sources (src/app minus api, src/ui), for affectedSections(). */
function appSources() {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p !== join(root, "src/app/api")) walk(p);
      } else if (/\.(m?[jt]sx?)$/.test(e.name)) {
        out.set(p.slice(root.length + 1), readFileSync(p, "utf8"));
      }
    }
  };
  walk(join(root, "src/app"));
  walk(join(root, "src/ui"));
  return out;
}

function key(i) {
  return `${i.check} | ${i.viewport} | ${i.route} | ${i.detail}`;
}

/** Strip volatile bits (numbers, hashes, ports) so findings are stable across runs. */
function norm(s) {
  return String(s)
    .replace(/https?:\/\/(localhost|127\.0\.0\.1):\d+/g, "")
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
    state: "fix the state's steps in states.json",
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
      // A trailing ` @dev` / ` @prod` limits the entry to that server mode.
      const mode = l.match(/\s@(dev|prod)$/)?.[1];
      const [check, viewport, route, ...rest] = l
        .replace(/\s@(dev|prod)$/, "")
        .split("|")
        .map((x) => x.trim());
      return { line: l, mode, check, viewport, route, detail: rest.join("|").trim() };
    })
    .filter((b) => !b.mode || b.mode === instance.mode);
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
    `${visited.length} page visits (${routes.length} routes, ${states.length} states; ${scope}) ` +
      `in ${secs}s (server ready after ${bootSecs}s). ` +
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
    for (const i of fresh)
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
