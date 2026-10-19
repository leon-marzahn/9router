#!/usr/bin/env node
// Screenshot dashboard routes against a throwaway instance seeded with demo data.
//
//   node scripts/pr-shots.mjs --routes /dashboard/usage,/dashboard/profile#routing [--out pr-shots] [--dark] [--label after]
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
// The mobile context emulates a phone (isMobile, hasTouch, iPhone user agent),
// so `(hover: hover)` is false and `(pointer: coarse)` true, like a real phone:
// `hover:` styles never show. There, `click` taps the element (falling back to a
// click if tapping fails) and `hover` has no visible effect. deviceScaleFactor
// stays 1 so mobile PNGs remain 375 px wide (sharper 3x shots would triple the
// file size and change image dimensions between runs).
//
// Browser requests can be answered without the server: scripts/pr-shots/mocks.json
// always applies (it keeps the Quota page off real providers), and a shot may add
// `"mocks": [{ "url": "**/api/x*", "status": 200, "json": {...} }]`; later entries win.
// String values like "{{+2h}}" become an ISO time that far from now (m, h, d).
//
// Before/after: run it on the base branch with `--label before` and on your
// branch with `--label after` into the same --out dir.
//
// Needs Chromium for playwright-core 1.63 (revision 1243). Agent environments
// have it under PLAYWRIGHT_BROWSERS_PATH; otherwise `bunx playwright@1.63.0 install chromium`.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applyMocks,
  settle as settlePage,
  startInstance,
  VIEWPORTS,
} from "./pr-shots/instance.mjs";

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
  if (!/^\/[\w\-/]*(#[\w-]+)?$/.test(r))
    throw new Error(`route must be a plain path like /dashboard/usage[#section]: ${r}`);
}

const shots = args.shots ? JSON.parse(readFileSync(resolve(args.shots), "utf8")) : [];
for (const sh of shots) {
  if (!/^[\w-]+$/.test(sh.name ?? "")) throw new Error(`shot needs a plain "name": ${sh.name}`);
  if (!/^\/[\w\-/]*$/.test(sh.route ?? ""))
    throw new Error(`shot "${sh.name}" needs a plain "route"`);
}

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const instance = await startInstance({ port: Number(args.port) || undefined, keep: args.keep });
const { base } = instance;
try {
  const themes = args.dark ? ["light", "dark"] : ["light"];
  for (const theme of themes) {
    for (const [vpName] of VIEWPORTS) {
      const context = await instance.newContext(vpName, theme);
      const page = await context.newPage();
      const fileFor = (slug) =>
        join(outDir, `${args.label ? args.label + "-" : ""}${slug}-${vpName}-${theme}.png`);
      const settle = () => settlePage(page);
      for (const route of routes) {
        await page.goto(base + route, { waitUntil: "load", timeout: 180_000 });
        await settle();
        // A `#id` route frames that section instead of the (inner-scrolling) full page.
        const hash = route.includes("#") ? route.slice(route.indexOf("#") + 1) : "";
        const section = hash ? page.locator(`[id="${hash}"]`) : null;
        if (section) await section.scrollIntoViewIfNeeded();
        const slug =
          route
            .replace(/^\/|\/$/g, "")
            .replace(/[/#]/g, "-")
            .replace(/[^\w.-]/g, "") || "root";
        const file = fileFor(slug);
        if (section) await section.screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      for (const shot of shots) {
        if (shot.viewports && !shot.viewports.includes(vpName)) continue;
        if (shot.mocks) await applyMocks(context, shot.mocks);
        await page.goto(base + shot.route, { waitUntil: "load", timeout: 180_000 });
        await settle();
        for (const step of shot.steps ?? []) await runStep(page, shot.name, step, vpName);
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
  await instance.stop();
}

async function runStep(page, name, step, vpName) {
  const t = { timeout: 15_000 };
  try {
    if (step.click && vpName === "mobile") {
      const el = page.locator(step.click).first();
      await el.tap(t).catch(() => el.click(t));
    } else if (step.click) await page.locator(step.click).first().click(t);
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
