// Integration: a real chatCore request with ENABLE_REQUEST_LOGS=true against a fake
// OpenAI-compatible upstream must not write the client key or the provider key to disk.
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const CLIENT_KEY = "sk-client-SEEDED-7f3a9c1e5b";
const PROVIDER_KEY = "sk-provider-SEEDED-2d8e4b6a0c";
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), "regent-reqlogs-"));

let server;
let baseUrl;

const chunk = (extra) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", ...extra })}\n\n`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": `s=${PROVIDER_KEY}` });
        res.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
        res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-session-token": PROVIDER_KEY });
        res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
  vi.stubEnv("REQUEST_LOGS_DIR", LOGS);
  vi.resetModules();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
  fs.rmSync(LOGS, { recursive: true, force: true });
});

function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("request logs", () => {
  it("never contain the client or provider key, streaming or not", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const clientHeaders = [{ authorization: `Bearer ${CLIENT_KEY}` }, { "x-api-key": CLIENT_KEY }, { "x-goog-api-key": CLIENT_KEY }, {}];
    for (const stream of [false, true]) {
      for (const headers of clientHeaders) {
        const body = { model: "m", stream, messages: [{ role: "user", content: "hi" }] };
        const result = await handleChatCore({
          body,
          modelInfo: { provider: "openai-compatible-test", model: "m" },
          credentials: { apiKey: PROVIDER_KEY, providerSpecificData: { baseUrl } },
          clientRawRequest: { endpoint: `/v1/chat/completions?key=${CLIENT_KEY}`, body, headers: { "content-type": "application/json", ...headers } },
          apiKey: CLIENT_KEY,
          connectionId: "conn-test",
        });
        expect(result.success).toBe(true);
        await result.response.text();
      }
    }
    await new Promise((r) => setTimeout(r, 50));
    const files = allFiles(LOGS);
    expect(files.some((f) => f.endsWith("4_req_target.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("1_req_client.json"))).toBe(true);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toContain(CLIENT_KEY);
      expect(text, f).not.toContain(PROVIDER_KEY);
    }
  });
});
