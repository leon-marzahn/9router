// Boot a throwaway, demo-seeded dashboard instance and open browser contexts on it.
// Shared by scripts/pr-shots.mjs (screenshots) and scripts/ui-smoke.mjs (CI smoke test).
//
// The server runs on a free port with DATA_DIR and HOME in a fresh temp dir
// (usage/log files ignore DATA_DIR, so HOME must move too), seeded by
// scripts/pr-shots/seed.mjs, with a random INITIAL_PASSWORD. Contexts are logged
// in and have scripts/pr-shots/mocks.json applied.
//
// mode "dev" (default) runs `next dev`, which compiles each route on its first
// hit. mode "prod" runs `next build` into its own dist dir (.next-smoke, so a
// local `next dev` keeps its .next) and then `next start`: slower to boot, but
// every page is precompiled, which pays off when many routes are visited, and
// no dev-server reloads interrupt pages visited in parallel.
// NEXT_PUBLIC_BASE_URL is inlined at build time, hence the build per port.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

export const root = resolve(import.meta.dirname, "../..");
const defaultMocks = JSON.parse(readFileSync(join(root, "scripts/pr-shots/mocks.json"), "utf8"));

/**
 * Viewports: name, size, device options. The mobile context emulates a phone
 * (isMobile, hasTouch, iPhone UA) so `(hover: hover)` is false and
 * `(pointer: coarse)` true. deviceScaleFactor stays 1 (set in newContext).
 */
export const VIEWPORTS = /** @type {const} */ ([
  ["desktop", { width: 1440, height: 900 }, {}],
  [
    "mobile",
    { width: 375, height: 812 },
    {
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
  ],
]);

/** @param {{ port?: number, keep?: boolean, mode?: "dev" | "prod" }} [opts] */
export async function startInstance(opts = {}) {
  // seed.mjs refuses to run unless HOME contains "pr-shots-".
  const tmp = mkdtempSync(join(tmpdir(), "pr-shots-"));
  const password = randomBytes(12).toString("hex");
  const port = opts.port || (await freePort());
  // Bound to loopback only: the instance has a known-to-us password and demo data.
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: join(tmp, "data"),
    HOME: join(tmp, "home"),
    USERPROFILE: join(tmp, "home"),
    APPDATA: join(tmp, "home"),
    INITIAL_PASSWORD: password,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_PUBLIC_BASE_URL: base,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_NO_WARNINGS: "1",
  };
  mkdirSync(env.HOME, { recursive: true });

  let server;
  let browser;
  /** @type {"dev" | "prod"} */
  let mode = "dev";
  const stop = async () => {
    await browser?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {}
    }
    if (!opts.keep) rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await run(
      "node",
      ["--import", "./scripts/pr-shots/register.mjs", "scripts/pr-shots/seed.mjs"],
      env,
    );
    mode = opts.mode ?? "dev";
    if (mode === "prod") {
      env.NEXT_DIST_DIR = ".next-smoke";
      const t0 = Date.now();
      await run("bunx", ["next", "build", "--webpack"], env, true);
      console.error(`next build: ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    // Production goes through custom-server.js like `bun run start` (it derives the
    // client IP that local-only APIs such as /api/cli-tools check).
    const [cmd, ...argv] =
      mode === "prod"
        ? ["node", "custom-server.js", "--hostname", "127.0.0.1", "--port", String(port)]
        : ["bunx", "next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)];
    server = spawn(cmd, argv, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let log = "";
    server.stdout.on("data", (d) => (log += d));
    server.stderr.on("data", (d) => (log += d));
    await waitFor(server, `${base}/api/health`, 180_000, () => log);
    browser = await chromium.launch();
  } catch (e) {
    await stop();
    throw e;
  }

  /** A logged-in context with default mocks applied. */
  async function newContext(viewportName, theme = "light") {
    const vp = VIEWPORTS.find(([n]) => n === viewportName);
    if (!vp) throw new Error(`unknown viewport ${viewportName}`);
    const [, viewport, device] = vp;
    const context = await browser.newContext({
      ...device,
      viewport,
      colorScheme: theme,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const login = await context.request.post(`${base}/api/auth/login`, { data: { password } });
    if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
    await applyMocks(context, defaultMocks);
    return context;
  }

  return { base, mode, newContext, stop };
}

export async function applyMocks(context, mocks) {
  for (const m of mocks) {
    if (typeof m.url !== "string" || !m.url)
      throw new Error(`mock needs a "url" glob: ${JSON.stringify(m)}`);
    await context.route(m.url, (route) =>
      route.fulfill({
        status: m.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(m.json ?? {}).replace(/\{\{\+(\d+)([mhd])\}\}/g, (_, n, unit) =>
          new Date(
            Date.now() + Number(n) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit],
          ).toISOString(),
        ),
      }),
    );
  }
}

/** Wait for the page to settle. Dev mode compiles on first hit and some pages keep SSE open. */
export async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  // Hide the Next dev-tools badge; it is not part of the UI under review.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1_000);
}

/**
 * Run one step of a shot/state (format: scripts/pr-shots.mjs header). On the
 * mobile context `click` taps, falling back to a click when tapping fails.
 */
export async function runStep(page, step, vpName) {
  const t = { timeout: 15_000 };
  if (step.click && vpName === "mobile") {
    const el = page.locator(step.click).first();
    await el.tap(t).catch(() => el.click(t));
  } else if (step.click) await page.locator(step.click).first().click(t);
  else if (step.hover) await page.locator(step.hover).first().hover(t);
  else if (step.fill) await page.locator(step.fill[0]).first().fill(String(step.fill[1]), t);
  else if (step.select)
    await page.locator(step.select[0]).first().selectOption(String(step.select[1]), t);
  else if (step.press) await page.keyboard.press(step.press);
  else if (step.waitFor) await page.locator(step.waitFor).first().waitFor(t);
  else if (step.wait) await page.waitForTimeout(Number(step.wait));
  else throw new Error("unknown step");
}

function run(cmd, argv, env, quiet = false) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, {
      cwd: root,
      env,
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${argv.join(" ")} exited ${code}`)),
    );
  });
}

async function waitFor(server, url, timeoutMs, getLog) {
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
