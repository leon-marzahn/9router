#!/usr/bin/env node
// Screenshot dashboard routes against a throwaway instance seeded with demo data.
//
//   node scripts/pr-shots.mjs --routes /dashboard/usage,/dashboard/profile [--out pr-shots] [--dark] [--label after]
//
// Boots `next dev` on a free port with DATA_DIR and HOME in a fresh temp dir
// (usage/log files ignore DATA_DIR, so HOME must move too), seeds demo data
// (scripts/pr-shots/seed.mjs), logs in with a random INITIAL_PASSWORD and saves
// <out>/<label>-<route>-<desktop|mobile>-<light|dark>.png.
//
// Specific states (an opened dialog, a filled form, a menu) go in a JSON file
// passed with --shots; each entry navigates to a route, runs its steps, then
// screenshots (the whole page, or just `selector`):
//
//   [{ "name": "add-model-dialog", "route": "/dashboard/providers",
//      "steps": [{ "click": "text=Add Custom Model" }, { "fill": ["input[name=id]", "demo"] },
//                { "waitFor": "[role=dialog]" }],
//      "selector": "[role=dialog]" }]
//
// Step keys: click, hover, press, waitFor (selector), fill ([selector, value]),
// wait (ms). Saved as <label>-<name>-<desktop|mobile>-<light|dark>.png.
// Set `"viewports": ["desktop"]` on an entry to skip mobile.
//
// Before/after: run it on the base branch with `--label before` and on your
// branch with `--label after` into the same --out dir.
//
// Needs Chromium for playwright-core 1.63 (revision 1243). Agent environments
// have it under PLAYWRIGHT_BROWSERS_PATH; otherwise `npx playwright@1.63.0 install chromium`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values: args } = parseArgs({
  options: {
    routes: { type: "string" },
    shots: { type: "string" },
    out: { type: "string", default: "pr-shots" },
    label: { type: "string", default: "" },
    dark: { type: "boolean", default: false },
    port: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.routes && !args.shots) {
  console.error(
    "usage: pr-shots.mjs [--routes /dashboard/usage,/dashboard/profile] [--shots shots.json] [--out dir] [--label name] [--dark]",
  );
  process.exit(2);
}
const routes = (args.routes ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
for (const r of routes) {
  if (!/^\/[\w\-/]*$/.test(r))
    throw new Error(`route must be a plain path like /dashboard/usage: ${r}`);
}

const shots = args.shots ? JSON.parse(readFileSync(resolve(args.shots), "utf8")) : [];
for (const sh of shots) {
  if (!/^[\w-]+$/.test(sh.name ?? "")) throw new Error(`shot needs a plain "name": ${sh.name}`);
  if (!/^\/[\w\-/]*$/.test(sh.route ?? "")) throw new Error(`shot "${sh.name}" needs a plain "route"`);
}

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), "pr-shots-"));
const password = randomBytes(12).toString("hex");
const port = Number(args.port) || (await freePort());
const base = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATA_DIR: join(tmp, "data"),
  HOME: join(tmp, "home"),
  USERPROFILE: join(tmp, "home"),
  APPDATA: join(tmp, "home"),
  INITIAL_PASSWORD: password,
  PORT: String(port),
  NEXT_PUBLIC_BASE_URL: base,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_NO_WARNINGS: "1",
};
mkdirSync(env.HOME, { recursive: true });

let server;
let browser;
try {
  await run("node", ["--import", "./scripts/pr-shots/register.mjs", "scripts/pr-shots/seed.mjs"]);

  server = spawn("npx", ["next", "dev", "--webpack", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  await waitFor(`${base}/api/health`, 180_000, () => log);

  browser = await chromium.launch();
  const themes = args.dark ? ["light", "dark"] : ["light"];
  const viewports = /** @type {const} */ ([
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 375, height: 812 }],
  ]);
  for (const theme of themes) {
    for (const [vpName, viewport] of viewports) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const login = await context.request.post(`${base}/api/auth/login`, { data: { password } });
      if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
      const page = await context.newPage();
      const fileFor = (slug) =>
        join(outDir, `${args.label ? args.label + "-" : ""}${slug}-${vpName}-${theme}.png`);
      const settle = async () => {
        // Dev mode compiles on first hit and some pages keep SSE open, so
        // networkidle can hang; settle on a short quiet period instead.
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        // Hide the Next dev-tools badge; it is not part of the UI under review.
        await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1_000);
      };
      for (const route of routes) {
        await page.goto(base + route, { waitUntil: "load", timeout: 180_000 });
        await settle();
        const slug = route.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "root";
        const file = fileFor(slug);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      for (const shot of shots) {
        if (shot.viewports && !shot.viewports.includes(vpName)) continue;
        await page.goto(base + shot.route, { waitUntil: "load", timeout: 180_000 });
        await settle();
        for (const step of shot.steps ?? []) await runStep(page, shot.name, step);
        await page.waitForTimeout(500);
        const file = fileFor(shot.name);
        if (shot.selector) await page.locator(shot.selector).first().screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await context.close();
    }
  }
} finally {
  await browser?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  if (!args.keep) rmSync(tmp, { recursive: true, force: true });
}

async function runStep(page, name, step) {
  const t = { timeout: 15_000 };
  try {
    if (step.click) await page.locator(step.click).first().click(t);
    else if (step.hover) await page.locator(step.hover).first().hover(t);
    else if (step.fill) await page.locator(step.fill[0]).first().fill(String(step.fill[1]), t);
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.waitFor) await page.locator(step.waitFor).first().waitFor(t);
    else if (step.wait) await page.waitForTimeout(Number(step.wait));
    else throw new Error("unknown step");
  } catch (e) {
    await page.screenshot({ path: join(outDir, `FAILED-${name}.png`) }).catch(() => {});
    throw new Error(`shot "${name}" step ${JSON.stringify(step)} failed: ${e.message}`);
  }
}

function run(cmd, argv) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { cwd: root, env, stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${argv.join(" ")} exited ${code}`)),
    );
  });
}

async function waitFor(url, timeoutMs, getLog) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${getLog()}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`server not ready after ${timeoutMs}ms:\n${getLog()}`);
}

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, () => {
      const { port: p } = s.address();
      s.close(() => ok(p));
    });
  });
}
