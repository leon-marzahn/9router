export default {
  id: "volink",
  alias: "volink",
  aliases: ["volink-ai"],
  uiAlias: "volink",
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  display: {
    name: "Volink",
    icon: "hub",
    color: "#7C3AED",
    textIcon: "VL",
    website: "https://volink.org",
    notice: {
      text: "Unified gateway for OpenAI, Anthropic, Google, DeepSeek, Qwen, GLM and more. Ids ending in -by-<vendor> pin a specific upstream.",
      apiKeyUrl: "https://volink.org/app/index.html#/",
    },
  },
  transport: {
    baseUrl: "https://api.volink.org/v1/chat/completions",
    validateUrl: "https://api.volink.org/v1/models",
  },
  // The catalogue at /v1/models is public, so modelsFetcher lists every id
  // (including the -by-<vendor> variants); the ids below are a seed.
  models: [
    { id: "claude-opus-5-5-by-anthropic", name: "Claude Opus 5.5", contextLength: 1000000 },
    { id: "claude-sonnet-5-5-by-anthropic", name: "Claude Sonnet 5.5", contextLength: 1000000 },
    { id: "claude-haiku-5-5-by-anthropic", name: "Claude Haiku 5.5", contextLength: 1000000 },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", contextLength: 1100000 },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", contextLength: 1100000 },
    { id: "gemini-3.8-flash-by-google", name: "Gemini 3.8 Flash", contextLength: 1000000 },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextLength: 1000000 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextLength: 1000000 },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1000000 },
    { id: "glm-5.3", name: "GLM 5.3", contextLength: 1000000 },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 1000000 },
    { id: "qwen3.8-max-0902", name: "Qwen3.8 Max", contextLength: 1000000 },
    { id: "minimax-m3", name: "MiniMax M3", contextLength: 524288 },
  ],
  modelsFetcher: { url: "https://api.volink.org/v1/models", type: "openai" },
  passthroughModels: true,
};
