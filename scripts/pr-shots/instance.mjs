// Boot a throwaway, demo-seeded dashboard instance and open browser contexts on it.
// Shared by scripts/pr-shots.mjs (screenshots) and scripts/ui-smoke.mjs (CI smoke test).
//
// `next dev` runs on a free port with DATA_DIR and HOME in a fresh temp dir
// (usage/log files ignore DATA_DIR, so HOME must move too), seeded by
// scripts/pr-shots/seed.mjs, with a random INITIAL_PASSWORD. Contexts are logged
// in and have scripts/pr-shots/mocks.json applied.
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

/** @param {{ port?: number, keep?: boolean }} [opts] */
export async function startInstance(opts = {}) {
  // seed.mjs refuses to run unless HOME contains "pr-shots-".
  const tmp = mkdtempSync(join(tmpdir(), "pr-shots-"));
  const password = randomBytes(12).toString("hex");
  const port = opts.port || (await freePort());
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
    server = spawn("bunx", ["next", "dev", "--webpack", "--port", String(port)], {
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

  return { base, newContext, stop };
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

function run(cmd, argv, env) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { cwd: root, env, stdio: "inherit" });
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
