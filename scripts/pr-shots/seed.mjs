// Seed deterministic demo data into the DB at $DATA_DIR (and tool configs under
// the throwaway $HOME). Run before the app boots (see scripts/pr-shots.mjs).
// Everything here is fake: keys and tokens are obvious placeholders that no
// upstream accepts. Connection ids are fixed (`demo-conn-*`) so mocks.json can
// answer the Quota page's /api/usage/:id calls without reaching a provider.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "@/lib/db/driver.js";
import {
  addCustomModel,
  createCombo,
  createProviderConnection,
  createProviderNode,
  createProxyPool,
  initDb,
  updateProviderConnection,
  updateSettings,
} from "@/lib/db/index.js";
import { saveRequestUsage } from "@/lib/db/repos/usageRepo.js";
import { validatePipelines } from "@/lib/request-pipelines/config.js";

if (!process.env.DATA_DIR || !process.env.HOME?.includes("pr-shots-")) {
  console.error("seed.mjs must run with a throwaway DATA_DIR and HOME (use scripts/pr-shots.mjs)");
  process.exit(1);
}

await initDb?.();
const db = await getAdapter();
const DAY = 24 * 3600_000;
const farFuture = new Date(Date.now() + 365 * DAY).toISOString();

/** Create a connection, then pin its id so mocks and usage rows can refer to it. */
async function seedConnection(id, data) {
  const conn = await createProviderConnection({
    testStatus: "active",
    isActive: true,
    authType: "apikey",
    ...data,
  });
  db.run(`UPDATE providerConnections SET id = ? WHERE id = ?`, [id, conn.id]);
  return { ...conn, id };
}

// API-key accounts, mixed states: healthy, rate-limited, paused.
const conns = [
  await seedConnection("demo-conn-openai-1", {
    provider: "openai",
    name: "Demo OpenAI",
    apiKey: "sk-demo-openai-0000000000000000",
  }),
  await seedConnection("demo-conn-openai-2", {
    provider: "openai",
    name: "Demo OpenAI (backup)",
    apiKey: "sk-demo-openai-1111111111111111",
  }),
  await seedConnection("demo-conn-anthropic-1", {
    provider: "anthropic",
    name: "Demo Anthropic",
    apiKey: "sk-ant-demo-000000000000000000",
  }),
  await seedConnection("demo-conn-openrouter-1", {
    provider: "openrouter",
    name: "Demo OpenRouter",
    apiKey: "sk-or-demo-0000000000000000000",
  }),
  await seedConnection("demo-conn-groq-1", {
    provider: "groq",
    name: "Demo Groq",
    apiKey: "gsk_demo_00000000000000000000",
  }),
];
// A custom OpenAI-compatible node (its edit dialog has node-level settings).
await createProviderNode({
  id: "openai-compatible-chat-demo",
  type: "openai-compatible",
  name: "Demo Compatible",
  prefix: "democ",
  apiType: "chat",
  baseUrl: "https://llm.example.com/v1",
});
await seedConnection("demo-conn-compatible-1", {
  provider: "openai-compatible-chat-demo",
  name: "Demo Compatible",
  apiKey: "sk-demo-compatible-000000000000",
  providerSpecificData: { prefix: "democ", apiType: "chat", baseUrl: "https://llm.example.com/v1", nodeName: "Demo Compatible" },
});
await seedConnection("demo-conn-groq-2", {
  provider: "groq",
  name: "Demo Groq (spare)",
  apiKey: "gsk_demo_11111111111111111111",
  testStatus: "unavailable",
  lastError: "429 rate limit reached (demo)",
  errorCode: 429,
});
// createProviderConnection drops modelLock_* keys; set the cooldown the way the
// router does when it hits a 429.
await updateProviderConnection("demo-conn-groq-2", {
  "modelLock_llama-3.3-70b-versatile": new Date(Date.now() + 40 * 60_000).toISOString(),
});
await seedConnection("demo-conn-deepseek-1", {
  provider: "deepseek",
  name: "Demo DeepSeek",
  apiKey: "sk-demo-deepseek-000000000000000",
});
await seedConnection("demo-conn-gemini-1", {
  provider: "gemini",
  name: "Demo Gemini",
  apiKey: "AIza-demo-gemini-000000000000000",
});
await seedConnection("demo-conn-mistral-1", {
  provider: "mistral",
  name: "Demo Mistral (paused)",
  apiKey: "demo-mistral-000000000000000000",
  isActive: false,
});

// Subscription (OAuth) accounts with quota. Tokens are placeholders and expire
// far in the future so the background refresher never tries them.
const oauth = (provider, id, email, extra = {}) =>
  seedConnection(id, {
    provider,
    authType: "oauth",
    email,
    name: email,
    accessToken: `demo-access-token-${id}`,
    refreshToken: `demo-refresh-token-${id}`,
    expiresAt: farFuture,
    ...extra,
  });
const claude1 = await oauth("claude", "demo-conn-claude-1", "ada@example.com");
const claude2 = await oauth("claude", "demo-conn-claude-2", "grace@example.com");
const codex1 = await oauth("codex", "demo-conn-codex-1", "linus@example.com", {
  providerSpecificData: { chatgptAccountId: "demo-account-0001", chatgptPlanType: "pro" },
});
await oauth("github", "demo-conn-github-1", "margaret@example.com", {
  providerSpecificData: { githubLogin: "demo-margaret" },
});
conns.push(claude1, claude2, codex1);

// Media providers (speech, transcription, embeddings, web search/fetch); one failing.
const mediaConnections = [
  ["elevenlabs", "Demo ElevenLabs", "sk-demo-elevenlabs-000000000000"],
  ["deepgram", "Demo Deepgram", "demo-deepgram-00000000000000000"],
  ["voyage-ai", "Demo Voyage", "pa-demo-voyage-000000000000000"],
  ["tavily", "Demo Tavily", "tvly-demo-00000000000000000000"],
  ["firecrawl", "Demo Firecrawl", "fc-demo-000000000000000000000"],
];
for (const [provider, name, apiKey] of mediaConnections) {
  await seedConnection(`demo-conn-${provider}-1`, { provider, name, apiKey });
}
await seedConnection("demo-conn-jina-ai-1", {
  provider: "jina-ai",
  name: "Demo Jina",
  apiKey: "jina_demo_expired_000000000000",
  testStatus: "error",
  lastError: "401 invalid api key (demo)",
  errorCode: 401,
});
await createCombo({ name: "search-combo", kind: "webSearch", models: ["tavily", "exa"] });

const keys = [
  ["demo-key-laptop", "Laptop (demo)", "sk-regent-demo-laptop-0000000000"],
  ["demo-key-ci", "CI runner (demo)", "sk-regent-demo-ci-000000000000000"],
  ["demo-key-team", "Team share (demo)", "sk-regent-demo-team-00000000000000"],
];
for (const [id, name, key] of keys) {
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, key, name, "demo-machine", 1, "2026-01-01T00:00:00.000Z", 0, "[]"],
  );
}

// Custom models on the Anthropic provider page: one named, one bare id, one long.
await addCustomModel({
  providerAlias: "anthropic",
  id: "claude-opus-4-6-demo",
  name: "Claude Opus 4.6 (demo)",
  caps: { vision: true },
});
await addCustomModel({ providerAlias: "anthropic", id: "claude-haiku-demo-preview" });
await addCustomModel({
  providerAlias: "anthropic",
  id: "claude-sonnet-4-5-20250929-extended-context-preview-demo",
  name: "Sonnet 4.5 extended context preview",
});

// Combos: the two original ones plus a few with other strategies.
await createCombo({
  name: "demo-fast",
  models: ["groq/llama-3.3-70b-versatile", "openai/gpt-4o-mini"],
});
await createCombo({
  name: "demo-smart",
  models: ["anthropic/claude-sonnet-4-5", "openrouter/openai/gpt-4o"],
});
await createCombo({
  name: "coding",
  models: [
    "cc/claude-sonnet-4-5",
    "cx/gpt-5",
    "anthropic/claude-sonnet-4-5",
    "openrouter/openai/gpt-4o",
  ],
});
await createCombo({
  name: "cheap-bulk",
  models: ["groq/llama-3.3-70b-versatile", "gemini/gemini-2.5-flash"],
});
await createCombo({
  name: "subscriptions",
  models: ["cc/claude-opus-4-1", "cx/gpt-5"],
});

// Customer pricing: a default markup and two named plans, set before the usage so
// every row gets a charge.
{
  const { setPricePlan, setKeyPlanId } = await import("@/lib/db/repos/pricePlansRepo.js");
  await setPricePlan("default", { name: "Default", markupPercent: 20, minFee: null, rates: [] });
  await setPricePlan("plan_demo_starter", {
    name: "Starter",
    markupPercent: 35,
    minFee: 0.002,
    rates: [],
  });
  await setPricePlan("plan_demo_pro", {
    name: "Pro",
    markupPercent: 15,
    minFee: null,
    rates: [{ model: "openai/gpt-4o-mini", input: 0.2, output: 0.8, cached: 0.1 }],
  });
  await setKeyPlanId("demo-key-laptop", "plan_demo_pro");
  await setKeyPlanId("demo-key-team", "plan_demo_starter");
}

// Usage over the last 30 days: busier on weekdays and during working hours,
// with a fixed pseudo-random sequence so totals are stable between runs.
const models = [
  ["claude", "claude-sonnet-4-5", 5, 6],
  ["claude", "claude-sonnet-4-5", 6, 5],
  ["codex", "gpt-5", 7, 4],
  ["openai", "gpt-4o-mini", 0, 4],
  ["openai", "gpt-4o", 1, 2],
  ["anthropic", "claude-sonnet-4-5", 2, 3],
  ["openrouter", "openai/gpt-4o", 3, 1],
  ["groq", "llama-3.3-70b-versatile", 4, 2],
];
const weighted = models.flatMap((m) => Array(m[3]).fill(m));
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const hour = 3600_000;
const now = Date.now();
const start = Math.floor(now / hour) * hour - 30 * DAY;
let n = 0;
for (let t = start; t < now - 5 * 60_000; t += hour) {
  const d = new Date(t);
  const weekday = d.getDay() !== 0 && d.getDay() !== 6;
  const h = d.getHours();
  const work = h >= 9 && h <= 19;
  const perHour = Math.round((weekday ? 1 : 0.35) * (work ? 5 : 0.6) * (0.5 + rand()));
  for (let k = 0; k < perHour; k++) {
    const [provider, model, ci] = weighted[Math.floor(rand() * weighted.length)];
    const prompt = 1500 + Math.floor(rand() * 28000);
    const agentic = provider === "claude" || provider === "codex";
    await saveRequestUsage({
      timestamp: new Date(t + Math.floor(rand() * hour)).toISOString(),
      provider,
      model,
      connectionId: conns[ci].id,
      apiKey: keys[Math.floor(rand() * keys.length)][2],
      endpoint: provider === "claude" ? "/v1/messages" : "/v1/chat/completions",
      status: rand() < 0.04 ? "error" : "ok",
      tokens: {
        prompt_tokens: prompt,
        completion_tokens: 150 + Math.floor(rand() * 2200),
        cached_tokens: agentic ? Math.floor(prompt * (0.5 + rand() * 0.4)) : 0,
      },
    });
    n++;
  }
}

// A few request-detail rows (the request inspector), newest last.
for (let i = 0; i < 6; i++) {
  const [provider, model, ci] = models[i % models.length];
  const timestamp = new Date(now - (6 - i) * 600_000).toISOString();
  const record = {
    id: `demo-detail-${i}`,
    // Routing traces live in server memory; mocks.json answers /api/usage/traces/tr_demo*.
    traceId: `tr_demo${i}trace`,
    provider,
    model,
    connectionId: conns[ci].id,
    timestamp,
    status: "success",
    latency: { ttft: 300 + i * 40, total: 1200 + i * 150 },
    tokens: {
      prompt_tokens: 12400 + i * 2310,
      completion_tokens: 640 + i * 155,
      cached_tokens: 8200 + i * 1900,
    },
    request: {
      model,
      messages: [{ role: "user", content: "Demo prompt: summarize the release notes." }],
      ...(i >= 4 && {
        regentHeaders: { "x-regent-pipeline": "demo-trim", "x-regent-token-saver": "off" },
      }),
    },
    providerRequest: {},
    providerResponse: {},
    response: { content: "Demo response.", finish_reason: "stop" },
  };
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      timestamp,
      provider,
      model,
      record.connectionId,
      record.status,
      JSON.stringify(record),
    ],
  );
}

// Proxy pools: healthy, failing, untested, paused and relay entries, two of them bound.
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const pools = [
  {
    name: "Office egress",
    proxyUrl: "http://proxy.example.internal:3128",
    noProxy: "localhost,127.0.0.1,.internal",
    testStatus: "active",
    lastTestedAt: ago(12 * 60_000),
  },
  {
    name: "Residential EU",
    proxyUrl: "socks5://demo:demo@eu.proxy.example:1080",
    strictProxy: true,
    testStatus: "active",
    lastTestedAt: ago(3 * 3600_000),
  },
  {
    name: "Datacenter US",
    proxyUrl: "http://us.proxy.example:8080",
    testStatus: "error",
    lastTestedAt: ago(40 * 60_000),
    lastError: "connect ETIMEDOUT",
  },
  {
    name: "Cloudflare relay",
    type: "cloudflare",
    proxyUrl: "https://demo-relay.example.workers.dev",
    testStatus: "active",
    lastTestedAt: ago(DAY),
  },
  { name: "Vercel relay", type: "vercel", proxyUrl: "https://demo-relay.vercel.app/api/relay" },
  {
    name: "Old staging proxy",
    proxyUrl: "http://staging.proxy.example:3128",
    isActive: false,
    testStatus: "error",
    lastTestedAt: ago(5 * DAY),
    lastError: "407 Proxy Authentication Required",
  },
];
const poolIds = [];
for (const p of pools) poolIds.push((await createProxyPool(p)).id);
await updateProviderConnection("demo-conn-openai-1", {
  providerSpecificData: { proxyPoolId: poolIds[0] },
});
await updateProviderConnection("demo-conn-anthropic-1", {
  providerSpecificData: { proxyPoolId: poolIds[0] },
});
await updateProviderConnection("demo-conn-openrouter-1", {
  providerSpecificData: { proxyPoolId: poolIds[1] },
});

// Token Saver page, combo strategies and request pipelines.
await updateSettings({
  customerViewEnabled: true,
  cavemanEnabled: true,
  cavemanLevel: "full",
  comboStrategies: {
    coding: { fallbackStrategy: "per-chat" },
    "cheap-bulk": { fallbackStrategy: "round-robin" },
  },
  requestPipelines: validatePipelines([
    {
      name: "no-secrets",
      description: "Mask keys and tokens pasted into prompts or tool output.",
      rules: [{ kind: "redact", label: "Redact secrets" }],
      attach: { keys: ["demo-key-team"], combos: [] },
    },
    {
      name: "agent-trim",
      description: "Drop repeated reminders and scratchpads from older turns.",
      rules: [
        { kind: "tag", tag: "system-reminder", depth: 2, replacement: "" },
        { kind: "tag", tag: "scratchpad", depth: 1, replacement: "" },
      ],
      attach: { keys: [], combos: ["coding"] },
    },
    {
      name: "roleplay-summary",
      rules: [
        {
          kind: "markers",
          start: "<!-- GFX_START -->",
          end: "<!-- GFX_END -->",
          depth: 1,
          replacement: "",
        },
        { kind: "details", title: "Scene Plan", depth: 1, replacement: "" },
      ],
    },
  ]),
});

// Connected CLI tools: point Claude Code, Codex and OpenCode at this instance
// by writing their config files in the throwaway HOME.
const base = `http://localhost:${process.env.PORT || 20128}`;
const home = process.env.HOME;
const write = (rel, text) => {
  const file = join(home, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
write(
  ".claude/settings.json",
  JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: `${base}/v1`,
        ANTHROPIC_AUTH_TOKEN: keys[0][2],
        ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-4-1",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "coding",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "demo-fast",
      },
    },
    null,
    2,
  ),
);
write(
  ".codex/config.toml",
  `model_provider = "regent"\nmodel = "cx/gpt-5"\n\n[model_providers.regent]\nname = "regent"\nbase_url = "${base}/v1"\nwire_api = "responses"\nhttp_headers = { Authorization = "Bearer ${keys[0][2]}" }\n`,
);
write(
  ".config/opencode/opencode.json",
  JSON.stringify(
    {
      provider: {
        regent: {
          npm: "@ai-sdk/openai-compatible",
          name: "regent",
          options: { baseURL: `${base}/v1`, apiKey: keys[0][2] },
          models: { coding: { name: "coding" } },
        },
      },
      model: "regent/coding",
    },
    null,
    2,
  ),
);

console.log(`seeded connections, ${keys.length} API keys, 6 combos, ${n} usage rows`);
process.exit(0);
