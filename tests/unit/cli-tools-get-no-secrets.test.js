// The CLI tool settings routes write the regent API key into each tool's config file.
// Their GET (and the all-statuses batch built from them) must never send it back: the
// dashboard only needs `current: { baseUrl, hasKey, models }`. Each case seeds the
// tool's config through its own POST with a known fake key, then asserts the key is
// absent from every GET body while `current.hasKey` proves the key was written.
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pretend every tool binary is on PATH so the GETs read their configs.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const exec = (cmd, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    done?.(null, "/usr/local/bin/tool\n", "");
    return { on() {}, kill() {} };
  };
  return { ...actual, default: { ...actual, exec }, exec };
});

const FAKE_KEY = "sk-regent-demo-FAKE0123456789abcdef";
const BASE = "http://127.0.0.1:20128/v1";

// toolId → POST body (key included); every route accepts baseUrl + apiKey.
const CASES = {
  claude: { env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: FAKE_KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-5" } },
  codex: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cx/gpt-5", subagentModel: "cx/gpt-5-mini" },
  opencode: { baseUrl: BASE, apiKey: FAKE_KEY, models: ["cc/claude-sonnet-5"] },
  droid: { baseUrl: BASE, apiKey: FAKE_KEY, models: ["cc/claude-sonnet-5"] },
  openclaw: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  hermes: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  cline: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  kilo: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  "deepseek-tui": { baseUrl: BASE, apiKey: FAKE_KEY, model: "ds/deepseek-chat" },
  jcode: { baseUrl: BASE, apiKey: FAKE_KEY, models: ["cc/claude-sonnet-5"] },
  "grok-build": { baseUrl: BASE, apiKey: FAKE_KEY, model: "xai/grok-4" },
  pi: { baseUrl: BASE, apiKey: FAKE_KEY, models: ["cc/claude-sonnet-5"] },
  omp: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  crush: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  forge: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  smelt: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  codewhale: { baseUrl: BASE, apiKey: FAKE_KEY, model: "cc/claude-sonnet-5" },
  cowork: { baseUrl: BASE, apiKey: FAKE_KEY, models: ["claude-sonnet-5"], plugins: [] },
};

const route = (toolId) => import(`../../src/app/api/cli-tools/${toolId}-settings/route.js`);
const post = (body) =>
  new Request("http://localhost/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = () => new Request("http://localhost/api");

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "regent-cli-secrets-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("APPDATA", path.join(home, "AppData", "Roaming"));
  vi.stubEnv("LOCALAPPDATA", path.join(home, "AppData", "Local"));
  vi.stubEnv("XDG_CONFIG_HOME", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("CLI tool settings GET never returns the API key", () => {
  for (const [toolId, body] of Object.entries(CASES)) {
    it(toolId, async () => {
      const r = await route(toolId);
      const wrote = await r.POST(post(body));
      expect(wrote.status, await wrote.clone().text()).toBe(200);
      expect(await wrote.text()).not.toContain(FAKE_KEY);

      const res = await r.GET(get());
      const text = await res.text();
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("FAKE0123456789");
      const data = JSON.parse(text);
      // Raw config blobs are gone from every tool.
      expect(data).not.toHaveProperty("config");
      if (toolId !== "cline" && toolId !== "kilo") expect(data).not.toHaveProperty("settings");
      // The config really holds the key (otherwise this test proves nothing) — unless
      // the tool isn't detectable in this sandbox (Claude Desktop for cowork).
      if (data.installed) expect(data.current?.hasKey).toBe(true);
    });
  }

  it("all-statuses batch", async () => {
    for (const [toolId, body] of Object.entries(CASES)) await (await route(toolId)).POST(post(body));
    const { GET } = await import("../../src/app/api/cli-tools/all-statuses/route.js");
    const text = await (await GET()).text();
    expect(text).not.toContain(FAKE_KEY);
    expect(Object.values(JSON.parse(text)).filter((s) => s?.current?.hasKey).length).toBeGreaterThan(10);
  });
});
