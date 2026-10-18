// Seed deterministic demo data into the DB at $DATA_DIR. Run before the app
// boots (see scripts/pr-shots.mjs). Everything here is fake: keys are obvious
// placeholders that no upstream accepts.
import { getAdapter } from "@/lib/db/driver.js";
import {
  addCustomModel,
  createCombo,
  createProviderConnection,
  initDb,
  updateSettings,
} from "@/lib/db/index.js";
import { saveRequestUsage } from "@/lib/db/repos/usageRepo.js";

if (!process.env.DATA_DIR || !process.env.HOME?.includes("pr-shots-")) {
  console.error("seed.mjs must run with a throwaway DATA_DIR and HOME (use scripts/pr-shots.mjs)");
  process.exit(1);
}

await initDb?.();
const db = await getAdapter();

const connections = [
  { provider: "openai", name: "Demo OpenAI", apiKey: "sk-demo-openai-0000000000000000" },
  { provider: "openai", name: "Demo OpenAI (backup)", apiKey: "sk-demo-openai-1111111111111111" },
  { provider: "anthropic", name: "Demo Anthropic", apiKey: "sk-ant-demo-000000000000000000" },
  { provider: "openrouter", name: "Demo OpenRouter", apiKey: "sk-or-demo-0000000000000000000" },
  { provider: "groq", name: "Demo Groq", apiKey: "gsk_demo_00000000000000000000" },
];
const conns = [];
for (const c of connections) {
  conns.push(
    await createProviderConnection({
      ...c,
      authType: "apikey",
      isActive: true,
      testStatus: "active",
    }),
  );
}

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

await createCombo({
  name: "demo-fast",
  models: ["groq/llama-3.3-70b-versatile", "openai/gpt-4o-mini"],
});
await createCombo({
  name: "demo-smart",
  models: ["anthropic/claude-sonnet-4-5", "openrouter/openai/gpt-4o"],
});

// Usage over the last 7 days, spaced on a fixed grid so totals are stable.
const models = [
  ["openai", "gpt-4o-mini", 0],
  ["openai", "gpt-4o", 1],
  ["anthropic", "claude-sonnet-4-5", 2],
  ["openrouter", "openai/gpt-4o", 3],
  ["groq", "llama-3.3-70b-versatile", 4],
];
const hour = 3600_000;
const start = Math.floor(Date.now() / hour) * hour - 7 * 24 * hour;
let n = 0;
for (let t = start; t < start + 7 * 24 * hour; t += 3 * hour) {
  const [provider, model, ci] = models[n % models.length];
  await saveRequestUsage({
    timestamp: new Date(t).toISOString(),
    provider,
    model,
    connectionId: conns[ci].id,
    apiKey: keys[n % keys.length][2],
    endpoint: n % 4 === 0 ? "/v1/messages" : "/v1/chat/completions",
    status: n % 17 === 0 ? "error" : "ok",
    tokens: { prompt_tokens: 800 + ((n * 137) % 2400), completion_tokens: 120 + ((n * 71) % 900) },
  });
  n++;
}

// A few request-detail rows (the request inspector), newest last.
for (let i = 0; i < 6; i++) {
  const [provider, model, ci] = models[i % models.length];
  const timestamp = new Date(start + 7 * 24 * hour - (6 - i) * 600_000).toISOString();
  const record = {
    id: `demo-detail-${i}`,
    provider,
    model,
    connectionId: conns[ci].id,
    timestamp,
    status: i === 4 ? "error" : "success",
    latency: { ttft: 300 + i * 40, total: 1200 + i * 150 },
    tokens: { prompt_tokens: 900 + i * 10, completion_tokens: 200 + i * 5 },
    request: {
      model,
      messages: [{ role: "user", content: "Demo prompt: summarize the release notes." }],
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

// Token Saver page.
await updateSettings({
  cavemanEnabled: true,
  cavemanLevel: "full",
});

console.log(
  `seeded ${conns.length} connections, ${keys.length} API keys, 2 combos, ${n} usage rows`,
);
process.exit(0);
