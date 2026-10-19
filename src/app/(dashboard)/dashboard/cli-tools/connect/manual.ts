import { CLI_TOOLS } from "@/shared/constants/cliTools.js";
import { DISPLAY_NAME, PROVIDER_KEY, prefixModel } from "@/shared/constants/brand.js";
import type { Values } from "./specs";

/** One file to paste by hand. */
export interface ManualFile {
  file: string;
  content: string;
}

/**
 * The config each tool would get from Connect, built in the browser from the
 * form so it can be pasted by hand (e.g. regent runs on another machine).
 * Never read from the settings routes: their GETs don't return the key.
 * `key` is the value (or placeholder) to write where the API key goes.
 */
type Build = (v: Values, key: string) => ManualFile[];

const PH = "provider/model-id";
const first = (v: Values) => v.models[0] || PH;
const json = (o: unknown) => JSON.stringify(o, null, 2);
const noV1 = (u: string) => u.replace(/\/v1$/, "");

type ClaudeTier = { alias: string; envKey: string };
const CLAUDE_TIERS = (CLI_TOOLS as unknown as { claude: { defaultModels: ClaudeTier[] } }).claude.defaultModels;

const BUILDERS: Record<string, Build> = {
  claude: (v, key) => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: v.baseUrl, ANTHROPIC_AUTH_TOKEN: key };
    for (const t of CLAUDE_TIERS) {
      const m = v.slots[t.alias]?.trim();
      if (m) env[t.envKey] = v.options.oneM && !m.endsWith("[1m]") ? `${m}[1m]` : m;
    }
    if (typeof v.options.autoCompactWindow === "string" && v.options.autoCompactWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = v.options.autoCompactWindow;
    return [{ file: "~/.claude/settings.json", content: json({ hasCompletedOnboarding: true, env }) }];
  },
  codex: (v, key) => [
    {
      file: "~/.codex/config.toml",
      content: `model = "${first(v)}"
model_provider = "${PROVIDER_KEY}"

[model_providers.${PROVIDER_KEY}]
name = "${DISPLAY_NAME}"
base_url = "${v.baseUrl}"
wire_api = "responses"

[model_providers.${PROVIDER_KEY}.http_headers]
Authorization = "Bearer ${key}"

[agents]
default_subagent_model = "${v.slots.subagent?.trim() || first(v)}"
`,
    },
  ],
  opencode: (v, key) => {
    const models = v.models.length ? v.models : [PH];
    return [
      {
        file: "~/.config/opencode/opencode.json",
        content: json({
          provider: {
            [PROVIDER_KEY]: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: v.baseUrl, apiKey: key },
              models: Object.fromEntries(models.map((m) => [m, { name: m, modalities: { input: ["text", "image"], output: ["text"] } }])),
            },
          },
          model: prefixModel(models[0]),
          agent: { explorer: { description: "Fast explorer subagent for codebase exploration", mode: "subagent", model: prefixModel(v.slots.subagent?.trim() || models[0]) } },
        }),
      },
    ];
  },
  droid: (v, key) => [
    {
      file: "~/.factory/settings.json",
      content: json({
        customModels: (v.models.length ? v.models : [PH]).map((m, i) => ({
          model: m,
          id: `custom:${PROVIDER_KEY}-${i}`,
          index: i,
          baseUrl: v.baseUrl,
          apiKey: key,
          displayName: m,
          maxOutputTokens: 131072,
          noImageSupport: false,
          provider: "openai",
        })),
      }),
    },
  ],
  openclaw: (v, key) => [
    {
      file: "~/.openclaw/openclaw.json",
      content: json({
        agents: { defaults: { model: { primary: prefixModel(first(v)) } } },
        models: { providers: { [PROVIDER_KEY]: { baseUrl: v.baseUrl, apiKey: key, api: "openai-completions", models: [{ id: first(v), name: first(v).split("/").pop() }] } } },
      }),
    },
  ],
  "grok-build": (v, key) => {
    const block = (slot: string, model: string, name: string) =>
      `[model.${slot}]\nmodel = "${model}"\nbase_url = "${v.baseUrl}"\nname = "${name}"\ndescription = "Routed via ${DISPLAY_NAME} gateway"\napi_backend = "chat_completions"\napi_key = "${key}"\ncontext_window = 200000`;
    const blocks = [`[models]\ndefault = "${PROVIDER_KEY}"`, block(PROVIDER_KEY, first(v), DISPLAY_NAME)];
    const maps: string[] = [];
    for (const [id, m] of Object.entries(v.slots)) {
      if (!m.trim()) continue;
      maps.push(`${id} = "${PROVIDER_KEY}-${id}"`);
      blocks.push(block(`${PROVIDER_KEY}-${id}`, m.trim(), `${DISPLAY_NAME} ${id}`));
    }
    if (maps.length) blocks.splice(1, 0, `[subagents.models]\n${maps.join("\n")}`);
    return [{ file: "~/.grok/config.toml", content: `${blocks.join("\n\n")}\n` }];
  },
  cowork: (v, key) => [
    {
      file: "~/Library/Application Support/Claude-3p/configLibrary/<id>.json",
      content: json({
        inferenceProvider: "gateway",
        inferenceGatewayBaseUrl: v.baseUrl,
        inferenceGatewayApiKey: key,
        inferenceModels: (v.models.length ? v.models : [PH]).map((name) => ({ name })),
      }),
    },
  ],
  hermes: (v, key) => {
    const home = !v.scope || v.scope === "default" ? "~/.hermes" : `~/.hermes/profiles/${v.scope}`;
    const custom = (indent: string, model: string) =>
      `${indent}provider: "custom"\n${indent}model: "${model}"\n${indent}base_url: "${v.baseUrl}"\n${indent}api_key: \${OPENAI_API_KEY}\n`;
    let yaml = `model:\n  default: "${first(v)}"\n  provider: "custom"\n  base_url: "${v.baseUrl}"\n  api_key: \${OPENAI_API_KEY}\n`;
    const roles = Object.entries(v.slots).filter(([, m]) => m.trim());
    const delegation = roles.find(([r]) => r === "delegation");
    if (delegation) yaml += `delegation:\n${custom("  ", delegation[1].trim())}`;
    const aux = roles.filter(([r]) => r !== "delegation");
    if (aux.length) yaml += `auxiliary:\n${aux.map(([r, m]) => `  ${r}:\n${custom("    ", m.trim())}`).join("")}`;
    const stt = typeof v.extra.sttModel === "string" ? v.extra.sttModel.trim() : "";
    if (v.extra.audioEnabled && stt) yaml += `stt:\n  enabled: true\n  provider: "openai"\n  openai:\n    model: "${stt}"\n    base_url: "${v.baseUrl}"\n    api_key: \${OPENAI_API_KEY}\n`;
    return [
      { file: `${home}/config.yaml`, content: yaml },
      { file: `${home}/.env`, content: `OPENAI_API_KEY=${key}\n` },
    ];
  },
  cline: (v, key) => [
    {
      file: "~/.cline/data/globalState.json",
      content: json({ actModeApiProvider: "openai", planModeApiProvider: "openai", openAiBaseUrl: noV1(v.baseUrl), openAiModelId: first(v), planModeOpenAiModelId: first(v) }),
    },
    { file: "~/.cline/data/secrets.json", content: json({ openAiApiKey: key }) },
  ],
  kilo: (v, key) => [
    {
      file: "~/.local/share/kilo/auth.json",
      content: json({ "openai-compatible": { type: "api-key", apiKey: key, baseUrl: v.baseUrl, model: first(v) } }),
    },
  ],
  "deepseek-tui": (v, key) => [
    { file: "~/.deepseek/config.toml", content: `[providers.openai]\nbase_url = "${v.baseUrl}"\napi_key = "${key}"\nmodel = "${first(v)}"\n` },
  ],
  jcode: (v, key) => {
    const envVar = `JCODE_${PROVIDER_KEY.toUpperCase()}_API_KEY`;
    const models = v.models.length ? v.models : [PH];
    return [
      {
        file: "~/.jcode/config.toml",
        content: `[providers.${PROVIDER_KEY}]
type = "openai-compatible"
base_url = "${v.baseUrl}"
auth = "bearer"
api_key_env = "${envVar}"
env_file = "provider-${PROVIDER_KEY}.env"
default_model = "${models[0]}"
requires_api_key = true
${models.map((m) => `\n[[providers.${PROVIDER_KEY}.models]]\nid = "${m}"`).join("\n")}
`,
      },
      { file: `~/.config/jcode/provider-${PROVIDER_KEY}.env`, content: `${envVar}="${key}"\n` },
    ];
  },
};

export const hasManual = (toolId: string) => toolId in BUILDERS;

export function manualFiles(toolId: string, v: Values, key: string): ManualFile[] {
  return BUILDERS[toolId]?.(v, key) ?? [];
}
