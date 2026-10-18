import { describe, it, expect } from "vite-plus/test";
import { stringifyTOML } from "confbox";
import * as S from "../../src/app/api/cli-tools/currentSummary.js";
import { applyRegentConfig } from "../../src/app/api/cli-tools/deepseek-tui-settings/deepseekConfig.js";
import { applyGrokBuildConfig, parseGrokBuildConfig } from "../../src/lib/grokBuildConfig.js";
import { buildModelBlock, parseModelBlock, upsertModelBlock } from "../../src/app/api/cli-tools/hermes-settings/hermesYaml.js";

const KEY = "sk-secret-abc123XYZ";
const BASE = "http://localhost:20128/v1";

const noKey = (result) => {
  const json = JSON.stringify(result);
  expect(json).not.toContain(KEY);
  expect(json).not.toMatch(/api_?key|authorization|token/i);
};

describe("cli-tools current summary", () => {
  it("claude: env slots from settings.json", () => {
    const r = S.claudeCurrent({
      env: {
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_AUTH_TOKEN: KEY,
        ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-7",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/claude-sonnet-4-6",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "cc/claude-haiku-4-5",
      },
    });
    expect(r).toEqual({
      baseUrl: BASE,
      hasKey: true,
      models: { opus: "cc/claude-opus-4-7", sonnet: "cc/claude-sonnet-4-6", haiku: "cc/claude-haiku-4-5", fable: null },
    });
    noKey(r);
    expect(S.claudeCurrent({ env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: "sk_9router" } }).hasKey).toBe(false);
    expect(S.claudeCurrent({ env: {} })).toBeNull();
    expect(S.claudeCurrent(null)).toBeNull();
  });

  it("codex: model + subagent from config.toml", () => {
    const toml = stringifyTOML({
      model: "cx/gpt-5.5",
      model_provider: "regent",
      model_providers: {
        regent: { name: "x", base_url: BASE, wire_api: "responses", http_headers: { Authorization: `Bearer ${KEY}` } },
      },
      agents: { default_subagent_model: "cx/gpt-5.5-mini" },
    });
    const r = S.codexCurrent(toml);
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "cx/gpt-5.5", subagent: "cx/gpt-5.5-mini" } });
    noKey(r);
    expect(S.codexCurrent('model = "o3"\n')).toBeNull();
    expect(S.codexCurrent(null)).toBeNull();
  });

  it("opencode: models/active/subagent", () => {
    const r = S.opencodeCurrent({
      provider: { regent: { options: { baseURL: BASE, apiKey: KEY }, models: { "a/m1": {}, "b/m2": {} } } },
      model: "regent/a/m1",
      agent: { explorer: { mode: "subagent", model: "regent/b/m2" } },
    });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { models: ["a/m1", "b/m2"], active: "a/m1", subagent: "b/m2" } });
    noKey(r);
    expect(S.opencodeCurrent({ provider: { other: {} } })).toBeNull();
  });

  it("droid: customModels list + active", () => {
    const entry = (model, i) => ({ model, id: `custom:regent-${i}`, index: i, baseUrl: BASE, apiKey: KEY, displayName: model, provider: "openai" });
    const r = S.droidCurrent({ customModels: [entry("b/m2", 1), entry("a/m1", 0), { id: "custom:other", model: "x", apiKey: "k" }] });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { models: ["a/m1", "b/m2"], active: "a/m1" } });
    noKey(r);
    expect(S.droidCurrent({ customModels: [] })).toBeNull();
  });

  it("openclaw: default primary model", () => {
    const r = S.openclawCurrent({
      agents: { defaults: { model: { primary: "regent/a/m1" } } },
      models: { providers: { regent: { baseUrl: BASE, apiKey: KEY, api: "openai-completions", models: [{ id: "a/m1" }] } } },
    });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.openclawCurrent({})).toBeNull();
  });

  it("cline: globalState model, key presence from secrets", () => {
    const gs = { actModeApiProvider: "openai", planModeApiProvider: "openai", openAiBaseUrl: "http://localhost:20128", openAiModelId: "a/m1" };
    const r = S.clineCurrent(gs, { openAiApiKey: KEY });
    expect(r).toEqual({ baseUrl: "http://localhost:20128", hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.clineCurrent(gs, null).hasKey).toBe(false);
    expect(S.clineCurrent({ actModeApiProvider: "anthropic" })).toBeNull();
  });

  it("kilo: openai-compatible auth entry", () => {
    const r = S.kiloCurrent({ "openai-compatible": { type: "api-key", apiKey: KEY, baseUrl: BASE, model: "a/m1" } });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.kiloCurrent({})).toBeNull();
  });

  it("deepseek-tui: [providers.openai] written by POST", () => {
    const toml = stringifyTOML(applyRegentConfig({ theme: "dark" }, "http://localhost:20128", KEY, "a/m1"));
    const r = S.deepseekTuiCurrent(toml);
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.deepseekTuiCurrent("")).toBeNull();
  });

  it("jcode: default_model, key presence from env file", () => {
    const r = S.jcodeCurrent(
      { providers: { regent: { type: "openai-compatible", base_url: BASE, api_key_env: "JCODE_REGENT_API_KEY", default_model: "a/m1" } } },
      true,
    );
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { models: ["a/m1"] } });
    noKey(r);
    expect(S.jcodeCurrent({ providers: {} })).toBeNull();
  });

  it("grok-build: main model + subagent slots", () => {
    const toml = applyGrokBuildConfig("", {
      baseUrl: BASE,
      apiKey: KEY,
      model: "a/m1",
      contextWindow: 200000,
      subagentModels: { explore: { model: "b/m2", contextWindow: 128000 } },
    });
    const r = S.grokBuildCurrent(parseGrokBuildConfig(toml));
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1", "subagent:explore": "b/m2" } });
    noKey(r);
    expect(S.grokBuildCurrent(parseGrokBuildConfig(""))).toBeNull();
  });

  it("pi: models list", () => {
    const r = S.piCurrent({
      providers: { regent: { baseUrl: BASE, apiKey: KEY, api: "openai-completions", models: [{ id: "a/m1" }, { id: "b/m2" }] } },
    });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { models: ["a/m1", "b/m2"] } });
    noKey(r);
    expect(S.piCurrent({ providers: {} })).toBeNull();
  });

  it("omp: provider block in models.yml (no models; discovery)", () => {
    const yml = `providers:\n  regent:\n    baseUrl: "${BASE}"\n    apiKey: "${KEY}"\n    api: openai-completions\n    discovery:\n      type: proxy\n  other:\n    baseUrl: "http://x"\n`;
    const r = S.ompCurrent(yml);
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: {} });
    noKey(r);
    expect(S.ompCurrent("providers:\n  other:\n    baseUrl: x\n")).toBeNull();
  });

  it("crush: first model", () => {
    const r = S.crushCurrent({
      providers: { regent: { type: "openai-compat", base_url: BASE, api_key: KEY, models: [{ id: "a/m1", name: "a/m1" }] } },
    });
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
  });

  it("forge / codewhale: [openai] table", () => {
    const cfg = { openai: { api_key: KEY, base_url: BASE, model: "a/m1" } };
    for (const fn of [S.forgeCurrent, S.codewhaleCurrent]) {
      const r = fn(cfg, true);
      expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
      noKey(r);
      expect(fn(cfg, false)).toBeNull();
    }
  });

  it("smelt: top-level fields", () => {
    const r = S.smeltCurrent({ baseUrl: BASE, apiKey: KEY, model: "a/m1", _managedBy: "regent" }, true);
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.smeltCurrent({ model: "x" }, false)).toBeNull();
  });

  it("cowork: inferenceModels", () => {
    const r = S.coworkCurrent({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "http://localhost:20128",
      inferenceGatewayApiKey: KEY,
      inferenceModels: [{ name: "a/m1" }, { name: "b/m2" }],
    });
    expect(r).toEqual({ baseUrl: "http://localhost:20128", hasKey: true, models: { models: ["a/m1", "b/m2"] } });
    noKey(r);
    expect(S.coworkCurrent({ inferenceProvider: "anthropic" })).toBeNull();
  });

  it("hermes: main model block + env key presence", () => {
    const yaml = upsertModelBlock("", buildModelBlock("a/m1", BASE));
    const r = S.hermesCurrent(parseModelBlock(yaml), `OPENAI_API_KEY=${KEY}\n`);
    expect(r).toEqual({ baseUrl: BASE, hasKey: true, models: { model: "a/m1" } });
    noKey(r);
    expect(S.hermesCurrent(parseModelBlock(yaml), "").hasKey).toBe(false);
    expect(S.hermesCurrent(null)).toBeNull();
  });
});
