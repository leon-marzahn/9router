#!/usr/bin/env node
// Retake the README screenshots in docs/images/readme/ from demo data.
//
//   node scripts/readme-shots.mjs                 # every shot
//   node scripts/readme-shots.mjs --only quota,pxpipe
//
// Boots the same throwaway, demo-seeded instance as scripts/pr-shots.mjs
// (scripts/pr-shots/seed.mjs + mocks.json; nothing from ~/.regent), runs each
// entry of scripts/pr-shots/readme-shots.json at desktop 1440x900 and writes
// <name>[-<theme>].webp. Shot format is the pr-shots --shots format, plus:
//   "themes": ["light", "dark"]  one file per theme, suffixed -light/-dark
//                                (default: light only, no suffix)
//   "width": 1080                resize to this width (default 1080; hero 1440)
//   "selector"                   screenshot just that element instead of the viewport
//
// Needs Chromium for playwright-core 1.63 (`bunx playwright@1.63.0 install chromium`)
// and sharp (installed with Next.js) for the webp encoding.
import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { root, runStep, settle, startInstance } from "./pr-shots/instance.mjs";

const { values: args } = parseArgs({ options: { only: { type: "string" } } });
const outDir = join(root, "docs/images/readme");
const all = JSON.parse(readFileSync(join(root, "scripts/pr-shots/readme-shots.json"), "utf8"));
const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const shots = only ? all.filter((s) => only.has(s.name)) : all;
if (only && shots.length !== only.size) {
  const known = all.map((s) => s.name).join(", ");
  throw new Error(`unknown shot in --only; known: ${known}`);
}

mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "readme-shots-"));
const instance = await startInstance();
try {
  for (const theme of ["light", "dark"]) {
    const todo = shots.filter((s) => (s.themes ?? ["light"]).includes(theme));
    if (!todo.length) continue;
    const context = await instance.newContext("desktop", theme);
    const page = await context.newPage();
    for (const shot of todo) {
      await page.goto(instance.base + shot.route, { waitUntil: "load", timeout: 180_000 });
      await settle(page);
      for (const step of shot.steps ?? []) {
        try {
          await runStep(page, step, "desktop");
        } catch (e) {
          throw new Error(`shot "${shot.name}" step ${JSON.stringify(step)} failed: ${e.message}`);
        }
      }
      await page.waitForTimeout(500);
      const png = join(tmp, `${shot.name}-${theme}.png`);
      if (shot.selector) await page.locator(shot.selector).first().screenshot({ path: png });
      else await page.screenshot({ path: png });
      const suffix = shot.themes ? `-${theme}` : "";
      const file = join(outDir, `${shot.name}${suffix}.webp`);
      const webp = await sharp(png)
        .resize({ width: shot.width ?? 1080, withoutEnlargement: true })
        .webp({ quality: 80, effort: 6 })
        .toBuffer();
      writeFileSync(file, webp);
      console.log(`${file} ${(webp.length / 1024).toFixed(1)} KiB`);
    }
    await context.close();
  }
} finally {
  await instance.stop();
  rmSync(tmp, { recursive: true, force: true });
}
