// Rebrand 9router → regent in third-party tool configs: writes use `regent` and drop
// the legacy `9router` entry, reads accept `regent` first then `9router`, removal drops both.
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTOML } from "confbox";
import {
  pickProvider,
  hasProviderPrefix,
  stripProviderPrefix,
  mentionsBrand,
} from "../../src/shared/constants/brand.js";
import {
  applyGrokBuildConfig,
  parseGrokBuildConfig,
  resetGrokBuildConfig,
} from "../../src/lib/grokBuildConfig.js";

const require = createRequire(import.meta.url);
const tools = require("../../cli/src/cli/commands/connectTools.js");
const cliBrand = require("../../cli/src/cli/utils/brand.js");
const tool = (id) => tools.TOOLS.find((t) => t.id === id);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const CTX = { baseUrl: "http://gw.test:20128", apiKey: "sk-new", model: "cc/new-model", claudeModels: {} };
const LEGACY_CODEX = [
  'model = "cc/old"',
  'model_provider = "9router"',
  "",
  "[model_providers.9router]",
  'name = "9Router"',
  'base_url = "http://old.test/v1"',
  'http_headers = { Authorization = "Bearer sk-old" }',
  "",
  "[model_providers.other]",
  'base_url = "http://other.test"',
  "",
].join("\n");
const LEGACY_OPENCODE = {
  model: "9router/cc/old",
  provider: {
    "9router": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://old.test/v1", apiKey: "sk-old" }, models: { "cc/old": { name: "cc/old" } } },
    other: { options: {} },
  },
  agent: { explorer: { model: "9router/cc/old" } },
};

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "regent-brand-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("brand helpers", () => {
  it("prefer the current key, fall back to legacy, and match either prefix", () => {
    expect(pickProvider({ "9router": 1, regent: 2 })).toBe(2);
    expect(pickProvider({ "9router": 1 })).toBe(1);
    expect(pickProvider({ other: 1 })).toBeUndefined();
    expect(hasProviderPrefix("9router/a")).toBe(true);
    expect(hasProviderPrefix("regent/a")).toBe(true);
    expect(hasProviderPrefix("openai/a")).toBe(false);
    expect(stripProviderPrefix("9router/x/y")).toBe("x/y");
    expect(mentionsBrand("https://9router.example.com")).toBe(true);
    expect(mentionsBrand("https://regent.example.com")).toBe(true);
  });

  it("the CLI copy matches the app constants", () => {
    expect(cliBrand.PROVIDER_KEY).toBe("regent");
    expect(cliBrand.LEGACY_PROVIDER_KEY).toBe("9router");
    expect(cliBrand.DISPLAY_NAME).toBe("Elizabeth's Proxy");
  });
});

describe("CLI connect writers", () => {
  it("codex: show reads legacy, apply migrates to regent (incl. profiles), reset removes both", async () => {
    const f = path.join(home, ".codex", "config.toml");
    const profile = path.join(home, ".codex", "fast.config.toml");
    write(f, LEGACY_CODEX);
    write(profile, '# codex -p fast\nmodel = "x"\nmodel_provider = "9router"\n');

    const shown = await tool("codex").show();
    expect(shown).toMatchObject({ baseUrl: "http://old.test/v1", apiKey: "sk-old", active: true });

    await tool("codex").apply(CTX);
    const cfg = parseTOML(fs.readFileSync(f, "utf8"));
    expect(cfg.model_provider).toBe("regent");
    expect(Object.keys(cfg.model_providers).sort()).toEqual(["other", "regent"]);
    expect(cfg.model_providers.regent.name).toBe("Elizabeth's Proxy");
    expect(fs.readFileSync(profile, "utf8")).toContain('model_provider = "regent"');

    // Both keys present (e.g. hand-edited) → reset drops both, keeps others.
    write(f, `${LEGACY_CODEX}\n[model_providers.regent]\nbase_url = "http://gw.test/v1"\n`);
    await tool("codex").reset();
    const after = parseTOML(fs.readFileSync(f, "utf8"));
    expect(after.model_provider).toBeUndefined();
    expect(Object.keys(after.model_providers)).toEqual(["other"]);
  });

  it("opencode: show reads legacy, apply migrates to regent, reset removes both", async () => {
    const f = path.join(home, ".config", "opencode", "opencode.json");
    write(f, JSON.stringify(LEGACY_OPENCODE));

    expect(await tool("opencode").show()).toMatchObject({ baseUrl: "http://old.test/v1", apiKey: "sk-old", active: true });
    expect(tool("opencode").serverModel({ current: { models: { active: "cc/old" } } })).toBe("cc/old");

    await tool("opencode").apply(CTX);
    const cfg = readJson(f);
    expect(Object.keys(cfg.provider).sort()).toEqual(["other", "regent"]);
    // Legacy models carried over into the migrated entry.
    expect(Object.keys(cfg.provider.regent.models).sort()).toEqual(["cc/new-model", "cc/old"]);
    expect(cfg.model).toBe("regent/cc/new-model");
    expect(cfg.agent.explorer.model).toBe("regent/cc/new-model");

    write(f, JSON.stringify({ ...LEGACY_OPENCODE, provider: { ...LEGACY_OPENCODE.provider, regent: {} } }));
    await tool("opencode").reset();
    const after = readJson(f);
    expect(Object.keys(after.provider)).toEqual(["other"]);
    expect(after.model).toBeUndefined();
    expect(after.agent).toBeUndefined();
  });

  it("crush: apply replaces a legacy entry instead of duplicating it", async () => {
    const f = path.join(home, ".config", "crush", "crush.json");
    write(f, JSON.stringify({ providers: { "9router": { base_url: "http://old/v1", models: [{ id: "old" }] } } }));
    expect((await tool("crush").show()).baseUrl).toBe("http://old/v1");
    await tool("crush").apply(CTX);
    expect(Object.keys(readJson(f).providers)).toEqual(["regent"]);
  });
});

describe("dashboard routes", () => {
  it("codex-settings: POST writes regent and drops legacy; DELETE removes both", async () => {
    const route = await import("../../src/app/api/cli-tools/codex-settings/route.js");
    const f = path.join(home, ".codex", "config.toml");
    write(f, LEGACY_CODEX);

    const post = await route.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ baseUrl: "http://gw.test", apiKey: "sk-new", model: "m" }) }));
    expect(post.status).toBe(200);
    const cfg = parseTOML(fs.readFileSync(f, "utf8"));
    expect(cfg.model_provider).toBe("regent");
    expect(Object.keys(cfg.model_providers).sort()).toEqual(["other", "regent"]);

    write(f, LEGACY_CODEX);
    await route.DELETE();
    const after = parseTOML(fs.readFileSync(f, "utf8"));
    expect(after.model_provider).toBeUndefined();
    expect(Object.keys(after.model_providers)).toEqual(["other"]);
  });

  it("opencode-settings: POST migrates legacy entry; DELETE removes both", async () => {
    const route = await import("../../src/app/api/cli-tools/opencode-settings/route.js");
    const f = path.join(home, ".config", "opencode", "opencode.json");
    write(f, JSON.stringify(LEGACY_OPENCODE));

    await route.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ baseUrl: "http://gw.test", apiKey: "sk-new", models: ["m"] }) }));
    const cfg = readJson(f);
    expect(Object.keys(cfg.provider).sort()).toEqual(["other", "regent"]);
    expect(cfg.provider.regent.options.baseURL).toBe("http://gw.test/v1");
    expect(cfg.model).toBe("regent/m");

    write(f, JSON.stringify(LEGACY_OPENCODE));
    await route.DELETE(new Request("http://x"));
    const after = readJson(f);
    expect(Object.keys(after.provider)).toEqual(["other"]);
    expect(after.model).toBeUndefined();
  });
});

describe("grok build legacy slots", () => {
  const LEGACY = [
    "[models]",
    'default = "9router"',
    "",
    "[subagents.models]",
    'explore = "9router-explore"',
    "",
    '# 9router-prev-default = "grok-build"',
    "[model.9router]",
    'model = "old"',
    'base_url = "http://old/v1"',
    "",
    "[model.9router-explore]",
    'model = "old-explore"',
    'base_url = "http://old/v1"',
    "",
  ].join("\n");

  it("parse reads legacy slots; apply renames them; reset restores the previous default", () => {
    const parsed = parseGrokBuildConfig(LEGACY);
    expect(parsed.model.model).toBe("old");
    expect(parsed.default).toBe("regent");
    expect(parsed.subagentModels.explore.model).toBe("old-explore");

    const applied = applyGrokBuildConfig(LEGACY, { baseUrl: "http://gw/v1", model: "new" });
    expect(applied).not.toContain("9router");
    expect(applied.match(/^\[model\.regent\]$/gm)).toHaveLength(1);
    expect(parseGrokBuildConfig(applied).model.model).toBe("new");

    const reset = resetGrokBuildConfig(LEGACY);
    expect(reset).not.toMatch(/9router|regent/);
    expect(parseGrokBuildConfig(reset).default).toBe("grok-build");
  });
});
