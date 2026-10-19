// Routing traces on disk (requestTracesRepo + migration 002): survive a
// simulated restart, pruned to the Settings request-log limit, rows hold no
// secrets, and the API resolves provider display names at read time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let trace, repo, adapter, db, GET;

const SECRET = "sk-live-SECRET-abcdef1234567890";
const PROXY = "http://puser:ppass@10.0.0.1:8080";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-traces-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.OBSERVABILITY_MAX_RECORDS;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  repo = await import("@/lib/db/repos/requestTracesRepo.js");
  trace = await import("@/lib/requestTrace.js");
  ({ GET } = await import("../../src/app/api/usage/traces/[id]/route.js"));
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  trace.__test__.reset();
  adapter.run("DELETE FROM requestTraces");
});

const call = (id) => GET(new Request(`http://localhost/api/usage/traces/${id}`), { params: Promise.resolve({ id }) });

function record({ provider = "openai", error } = {}) {
  const t = trace.startTrace({ endpoint: "/v1/chat/completions" });
  trace.runWithTrace(t, () => trace.setRequestedModel("my-alias"));
  const a1 = trace.beginAttempt({ provider, model: "gpt-4o", connectionId: "c1", connectionLabel: "Primary", requestedModel: "my-alias" }, t);
  trace.annotateAttempt(a1, { sourceFormat: "openai", targetFormat: "openai", stream: false, upstreamModel: "gpt-4o-2024-08-06" });
  trace.endAttempt(a1, { status: 429, error: error ?? `limit for ${SECRET} via ${PROXY}`, fallback: "account" });
  const a2 = trace.beginAttempt({ provider, model: "gpt-4o", connectionId: "c2", connectionLabel: "Backup" }, t);
  trace.endAttempt(a2, { status: 200 });
  trace.finishTrace(t, { status: 200, stream: false });
  return t.id;
}

describe("persistence", () => {
  it("writes traces to SQLite and reads them back after a restart", async () => {
    const id = record();
    await trace.flushTraces();
    trace.__test__.reset(); // simulated restart: the in-memory cache is gone
    expect(trace.getTrace(id)).toBeNull();
    const loaded = await trace.loadTrace(id);
    expect(loaded.attempts).toHaveLength(2);
    expect(loaded.attempts[0]).toMatchObject({ statusCode: 429, reason: "rate_limit", fallback: "account", upstreamModel: "gpt-4o-2024-08-06", requestedModel: "my-alias" });
    const res = await call(id);
    expect(res.status).toBe(200);
  });

  it("stores no secrets in the DB row", async () => {
    const id = record();
    await trace.flushTraces();
    const row = adapter.get("SELECT data FROM requestTraces WHERE id = ?", [id]);
    for (const s of [SECRET, "ppass", "puser"]) expect(row.data).not.toContain(s);
    for (const f of ["apiKey", "accessToken", "refreshToken", "headers", "cookie", "providerSpecificData"]) {
      expect(row.data).not.toContain(`"${f}"`);
    }
  });

  it("prunes to the request-log limit from Settings", async () => {
    await db.updateSettings({ observabilityMaxRecords: 3 });
    // The observability config is cached for a few seconds; drop the cache.
    (await import("@/lib/db/repos/requestDetailsRepo.js")).__test__.resetConfigCache();
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const t = trace.startTrace({});
      t.timestamp = new Date(Date.now() - (10 - i) * 1000).toISOString();
      ids.push(t.id);
    }
    await repo.saveRequestTraces(ids.map((id) => trace.getTrace(id)));
    const left = adapter.all("SELECT id FROM requestTraces ORDER BY timestamp").map((r) => r.id);
    expect(left).toEqual(ids.slice(3));
  });

  it("never throws when the DB write fails", async () => {
    const spy = vi.spyOn(repo, "saveRequestTraces");
    record();
    adapter.run("ALTER TABLE requestTraces RENAME TO requestTraces_off");
    try {
      await expect(trace.flushTraces()).resolves.toBeUndefined();
    } finally {
      adapter.run("ALTER TABLE requestTraces_off RENAME TO requestTraces");
      spy.mockRestore();
    }
  });
});

describe("provider name resolution", () => {
  it("uses the registry display name for built-ins", async () => {
    const id = record({ provider: "openai" });
    const body = await (await call(id)).json();
    expect(body.attempts[0].providerName).toBe("OpenAI");
  });

  it("uses the custom node's current name, and the id once the node is deleted", async () => {
    const node = await db.createProviderNode({ id: "openai-compatible-chat-test1", type: "openai-compatible", name: "Old Name", prefix: "t1", apiType: "chat", baseUrl: "http://127.0.0.1:1/v1" });
    const id = record({ provider: node.id });
    await trace.flushTraces();
    await db.updateProviderNode(node.id, { name: "Renamed Mock" });
    expect((await (await call(id)).json()).attempts[0].providerName).toBe("Renamed Mock");
    await db.deleteProviderNode(node.id);
    expect((await (await call(id)).json()).attempts[0].providerName).toBe(node.id);
  });
});
