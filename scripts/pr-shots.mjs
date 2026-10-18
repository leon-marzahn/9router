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
// Before/after: run it on the base branch with `--label before` and on your
// branch with `--label after` into the same --out dir.
//
// Needs Chromium for playwright-core 1.63 (revision 1243). Agent environments
// have it under PLAYWRIGHT_BROWSERS_PATH; otherwise `npx playwright@1.63.0 install chromium`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values: args } = parseArgs({
  options: {
    routes: { type: "string" },
    out: { type: "string", default: "pr-shots" },
    label: { type: "string", default: "" },
    dark: { type: "boolean", default: false },
    port: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.routes) {
  console.error(
    "usage: pr-shots.mjs --routes /dashboard/usage,/dashboard/profile [--out dir] [--label name] [--dark]",
  );
  process.exit(2);
}
const routes = args.routes
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
for (const r of routes) {
  if (!/^\/[\w\-/]*$/.test(r))
    throw new Error(`route must be a plain path like /dashboard/usage: ${r}`);
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

  server = spawn("npx", ["next", "dev", "--port", String(port)], {
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
      for (const route of routes) {
        await page.goto(base + route, { waitUntil: "load", timeout: 180_000 });
        // Dev mode compiles on first hit and some pages keep SSE open, so
        // networkidle can hang; settle on a short quiet period instead.
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        // Hide the Next dev-tools badge; it is not part of the UI under review.
        await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(1_000);
        const slug = route.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "root";
        const file = join(
          outDir,
          `${args.label ? args.label + "-" : ""}${slug}-${vpName}-${theme}.png`,
        );
        await page.screenshot({ path: file, fullPage: true });
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
