import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// agent.api5.cursor.sh is HTTP/2-only, so cursorModels.js talks raw node:http2
// (commit 6994cd1f) instead of fetch. Mock http2.connect so no request leaves the box.
const h2 = vi.hoisted(() => ({ reply: null, calls: [] }));
vi.mock("http2", () => {
  const connect = (origin) => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      const req = new EventEmitter();
      req.end = (body) => {
        h2.calls.push({ origin, headers, body });
        queueMicrotask(() => {
          req.emit("response", { ":status": h2.reply.status });
          if (h2.reply.body?.length) req.emit("data", Buffer.from(h2.reply.body));
          req.emit("end");
        });
      };
      return req;
    };
    return client;
  };
  return { default: { connect }, connect };
});
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";


function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.calls.length = 0;
    h2.reply = null;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    h2.reply = { status: 200, body: payload };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.calls).toHaveLength(1);
    const [call] = h2.calls;
    expect(call.origin).toBe("https://agent.api5.cursor.sh");
    expect(call.headers).toMatchObject({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      "content-type": "application/proto",
      accept: "application/proto",
    });
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.reply = { status: 403, body: Buffer.from("no") };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
    expect(h2.calls).toHaveLength(1);
  });
});
