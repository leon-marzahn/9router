import { describe, it, expect } from "vite-plus/test";
import fs from "fs";
import path from "path";
import { RESET_ENV_KEYS } from "../../src/app/api/cli-tools/claude-settings/claudeEnv.js";

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "../..", rel), "utf-8");

describe("Claude Code reset", () => {
  it("removes every env key the card or tool catalog can write", () => {
    const sources = read("src/app/(dashboard)/dashboard/cli-tools/components/ClaudeToolCard.js")
      + read("src/shared/constants/cliTools.js");
    const written = new Set(sources.match(/\b(?:ANTHROPIC_[A-Z_]+|CLAUDE_CODE_AUTO_COMPACT_WINDOW|API_TIMEOUT_MS)\b/g));
    expect([...written].filter((k) => !RESET_ENV_KEYS.includes(k))).toEqual([]);
    expect(RESET_ENV_KEYS).toContain("ANTHROPIC_DEFAULT_FABLE_MODEL");
    expect(RESET_ENV_KEYS).toContain("ANTHROPIC_MODEL");
  });
});
