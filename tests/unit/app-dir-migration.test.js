import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MODULE = require.resolve("../../src/lib/appDir.cjs");

// Fresh module per test: defaultDataDir() memoises its answer.
function load() {
  delete require.cache[MODULE];
  return require(MODULE);
}

describe("default data dir (rename 9router → regent)", () => {
  let home;
  const saved = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "appdir-"));
    for (const k of ["HOME", "USERPROFILE", "APPDATA"]) saved[k] = process.env[k];
    process.env.HOME = process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("moves a pre-rename data dir to the new name once, keeping its contents", () => {
    const { dirFor, defaultDataDir } = load();
    const legacy = dirFor("9router");
    fs.mkdirSync(path.join(legacy, "db"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "db", "data.sqlite"), "db");

    const dir = defaultDataDir();

    expect(dir).toBe(dirFor("regent"));
    expect(fs.readFileSync(path.join(dir, "db", "data.sqlite"), "utf8")).toBe("db");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("prefers an existing new dir and leaves the legacy one alone", () => {
    const { dirFor, defaultDataDir } = load();
    fs.mkdirSync(dirFor("regent"), { recursive: true });
    fs.mkdirSync(dirFor("9router"), { recursive: true });

    expect(defaultDataDir()).toBe(dirFor("regent"));
    expect(fs.existsSync(dirFor("9router"))).toBe(true);
  });

  it("uses the new name on a fresh install", () => {
    const { dirFor, defaultDataDir } = load();
    expect(defaultDataDir()).toBe(dirFor("regent"));
  });
});
