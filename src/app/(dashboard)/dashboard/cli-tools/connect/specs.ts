/**
 * Tools the shared connect panel drives end to end: their settings route takes
 * `{ baseUrl, apiKey, model }` (or `models` for list tools) and their config has
 * no extra options. Other tools keep their own card for now.
 * `apiKey: ""` lets the server pick the first active key (resolveCliApiKey).
 */
export interface ToolSpec {
  /** List tools take several models; the first is the default. */
  multi?: boolean;
  /** Plain-language name of the config file, shown above the preview. */
  file: string;
}

export const SPECS: Record<string, ToolSpec> = {
  cline: { file: "Cline's global state (~/.cline/data)" },
  kilo: { file: "~/.local/share/kilo/auth.json (+ VS Code settings)" },
  "deepseek-tui": { file: "~/.deepseek/config.toml" },
  crush: { file: "crush.json in your config folder" },
  forge: { file: "~/.forge/config.toml" },
  smelt: { file: "~/.smelt/config.json" },
  codewhale: { file: "~/.codewhale/config.toml" },
  omp: { file: "~/.omp/agent/models.yml" },
  pi: { multi: true, file: "~/.pi/agent/models.json" },
  jcode: { multi: true, file: "~/.jcode/config.toml (+ key in ~/.config/jcode)" },
};

export const settingsUrl = (toolId: string) => `/api/cli-tools/${toolId}-settings`;

export function bodyFor(toolId: string, v: { baseUrl: string; apiKey: string; models: string[] }) {
  const spec = SPECS[toolId];
  return spec?.multi
    ? { baseUrl: v.baseUrl, apiKey: v.apiKey, models: v.models }
    : { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.models[0] };
}

/** Every route wants the OpenAI-style base with /v1. */
export const withV1 = (url: string) => (url.replace(/\/+$/, "").endsWith("/v1") ? url.replace(/\/+$/, "") : `${url.replace(/\/+$/, "")}/v1`);
