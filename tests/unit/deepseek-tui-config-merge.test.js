import { describe, it, expect } from "vite-plus/test";
import { parseTOML, stringifyTOML } from "confbox";
import {
  parseExistingToml, applyRegentConfig, removeRegentConfig,
} from "../../src/app/api/cli-tools/deepseek-tui-settings/deepseekConfig.js";

const USER_CONFIG = `provider = "deepseek"
theme = "dark"

[providers.deepseek]
api_key = "sk-user-deepseek"

[providers.openai]
timeout = 30
`;

describe("DeepSeek TUI config merge", () => {
  it("adds only our keys and keeps the user's", () => {
    const out = parseTOML(stringifyTOML(applyRegentConfig(parseExistingToml(USER_CONFIG), "http://localhost:20128", "sk-r", "m1")));
    expect(out.provider).toBe("openai");
    expect(out.theme).toBe("dark");
    expect(out.providers.deepseek.api_key).toBe("sk-user-deepseek");
    expect(out.providers.openai).toEqual({ timeout: 30, base_url: "http://localhost:20128/v1", model: "m1", api_key: "sk-r" });
  });

  it("reset removes only our keys", () => {
    const applied = applyRegentConfig(parseExistingToml(USER_CONFIG), "http://localhost:20128", "sk-r", "m1");
    const out = parseTOML(stringifyTOML(removeRegentConfig(applied)));
    expect(out).toEqual({ theme: "dark", providers: { deepseek: { api_key: "sk-user-deepseek" }, openai: { timeout: 30 } } });
  });

  it("reset of a regent-only config leaves an empty file", () => {
    expect(removeRegentConfig(applyRegentConfig({}, "http://x/v1", "", "m"))).toEqual({});
  });

  it("refuses to overwrite a file it cannot parse", () => {
    expect(() => parseExistingToml("this is = = not toml [")).toThrow(/not valid TOML/);
  });

  it("rejects control characters in values", () => {
    expect(() => applyRegentConfig({}, "http://x/v1", "", "m\n[evil]")).toThrow();
  });
});
