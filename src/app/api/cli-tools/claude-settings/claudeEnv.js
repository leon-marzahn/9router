// Every env key the Claude Code card can write into ~/.claude/settings.json; Reset removes
// exactly these (tests/unit/claude-settings-reset-keys.test.js keeps the list complete).
export const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];
