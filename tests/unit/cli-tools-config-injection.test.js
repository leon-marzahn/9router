import { describe, it, expect } from "vite-plus/test";
import { parseTOML } from "confbox";
import {
  tomlString,
  yamlString,
  dotenvString,
  ConfigValueError,
} from "../../src/app/api/cli-tools/configText.js";
import {
  buildModelBlock,
  buildAuxRoleBlock,
  buildDelegationBlock,
  upsertModelBlock,
  upsertAuxRole,
  upsertEnvVar,
  parseModelBlock,
} from "../../src/app/api/cli-tools/hermes-settings/hermesYaml.js";
import { buildCodexProfileToml } from "../../src/app/(dashboard)/dashboard/cli-tools/components/codexConfig.js";
import { applyGrokBuildConfig } from "../../src/lib/grokBuildConfig.js";

const QUOTE_BREAKOUT = 'gpt"\nmodel_provider = "evil';
const YAML_BREAKOUT = 'x"\n  api_key: stolen\nevil: "1';

describe("config value quoting", () => {
  it("keeps quotes and backslashes inside one TOML string", () => {
    const v = "a\"b\\c$'d";
    expect(parseTOML(`k = ${tomlString(v)}`)).toEqual({ k: v });
  });

  it("rejects line breaks and control characters", () => {
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\tb", "a\u007fb", "a\u0085b"]) {
      expect(() => tomlString(bad)).toThrow(ConfigValueError);
      expect(() => yamlString(bad)).toThrow(ConfigValueError);
      expect(() => dotenvString(bad)).toThrow(ConfigValueError);
    }
  });

  it("escapes dotenv values", () => {
    expect(dotenvString('k"e\\y')).toBe('"k\\"e\\\\y"');
  });
});

describe("codex profile TOML", () => {
  it("cannot add keys through the model id", () => {
    expect(() => buildCodexProfileToml({ name: "p", model: QUOTE_BREAKOUT })).toThrow(
      ConfigValueError,
    );
    const toml = buildCodexProfileToml({ name: "p", model: 'a"b\\' });
    expect(parseTOML(toml)).toEqual({ model: 'a"b\\', model_provider: "regent" });
  });
});

describe("grok-build TOML", () => {
  it("rejects a model id that would open a new section", () => {
    expect(() =>
      applyGrokBuildConfig("", {
        baseUrl: "http://localhost:20128/v1",
        apiKey: "k",
        model: 'm"\n[evil]\nx = "1',
      }),
    ).toThrow(ConfigValueError);
  });
});

describe("hermes YAML", () => {
  it("rejects YAML breakouts in model and base_url", () => {
    expect(() => buildModelBlock(YAML_BREAKOUT, "http://x/v1")).toThrow(ConfigValueError);
    expect(() => buildDelegationBlock("m", YAML_BREAKOUT)).toThrow(ConfigValueError);
  });

  it("rejects role names that are not identifiers", () => {
    expect(() => buildAuxRoleBlock("vision:\n  evil", "m", "http://x/v1")).toThrow(
      ConfigValueError,
    );
    expect(() => upsertAuxRole("", "a.*", "  a:\n")).toThrow(ConfigValueError);
  });

  it("does not expand $-patterns from values during replace", () => {
    const yaml = 'model:\n  default: "old"\nother: keep\n';
    const out = upsertModelBlock(yaml, buildModelBlock("m$'$&", "http://x/v1"));
    expect(out).toContain('default: "m$\'$&"');
    expect(out.match(/other: keep/g)).toHaveLength(1);
    expect(parseModelBlock(out).base_url).toBe("http://x/v1");
  });

  it("rejects a newline in an .env value", () => {
    expect(() => upsertEnvVar("", "OPENAI_API_KEY", "k\nEVIL=1")).toThrow(ConfigValueError);
    expect(upsertEnvVar("A=1\n", "OPENAI_API_KEY", "k$&")).toBe("A=1\nOPENAI_API_KEY=k$&\n");
  });
});
