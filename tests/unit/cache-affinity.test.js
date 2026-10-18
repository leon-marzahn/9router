import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(), validateApiKey: vi.fn(), updateProviderConnection: vi.fn(),
  getSettings: vi.fn(), getProxyPools: vi.fn(async () => []),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn(),
}));

import { getProviderConnections, getSettings } from "@/lib/localDb";
import { deriveAffinityKey, pickByAffinity } from "../../src/sse/services/cacheAffinity.js";
import { getProviderCredentials } from "../../src/sse/services/auth.js";

const SECRET = "my secret system prompt about project zebra";
const turn1 = { model: "x", messages: [{ role: "system", content: SECRET }, { role: "user", content: "hello" }] };
const turn2 = { ...turn1, messages: [...turn1.messages, { role: "assistant", content: "hi" }, { role: "user", content: "more" }] };

describe("deriveAffinityKey", () => {
  it("is stable across turns of one conversation", () => {
    expect(deriveAffinityKey(turn1)).toBe(deriveAffinityKey(turn2));
  });
  it("differs across conversations", () => {
    const other = { ...turn1, messages: [turn1.messages[0], { role: "user", content: "different task" }] };
    expect(deriveAffinityKey(other)).not.toBe(deriveAffinityKey(turn1));
  });
  it("covers Claude and Responses formats", () => {
    const claude = { system: [{ type: "text", text: SECRET }], messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    const claude2 = { ...claude, messages: [...claude.messages, { role: "assistant", content: "x" }, { role: "user", content: "y" }] };
    expect(deriveAffinityKey(claude)).toBe(deriveAffinityKey(claude2));
    expect(deriveAffinityKey({ instructions: SECRET, input: "hello" })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("prefers an explicit session id over the prompt", () => {
    const a = deriveAffinityKey(turn1, { "x-session-id": "s1" });
    expect(a).toBe(deriveAffinityKey({ messages: [{ role: "user", content: "other" }] }, new Headers({ "X-Session-Id": "s1" })));
    expect(a).not.toBe(deriveAffinityKey(turn1));
    expect(deriveAffinityKey({ prompt_cache_key: "k" })).toBe(deriveAffinityKey({ prompt_cache_key: "k", messages: turn1.messages }));
    expect(deriveAffinityKey({ metadata: { user_id: JSON.stringify({ session_id: "abc" }) } })).toBeTruthy();
  });
  it("returns an opaque digest without prompt text", () => {
    const key = deriveAffinityKey(turn1);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("zebra");
  });
  it("returns null when there is nothing stable", () => {
    expect(deriveAffinityKey({})).toBeNull();
    expect(deriveAffinityKey(null)).toBeNull();
  });
});

describe("pickByAffinity", () => {
  const conns = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const keys = Array.from({ length: 50 }, (_, i) => deriveAffinityKey({ messages: [{ role: "user", content: `c${i}` }] }));

  it("spreads conversations across accounts", () => {
    expect(new Set(keys.map((k) => pickByAffinity(k, conns).id)).size).toBeGreaterThan(2);
  });
  it("removing an unrelated account does not move a key", () => {
    for (const k of keys) {
      const pick = pickByAffinity(k, conns).id;
      const other = conns.find((c) => c.id !== pick);
      expect(pickByAffinity(k, conns.filter((c) => c !== other)).id).toBe(pick);
    }
  });
  it("moves to the same next account when the preferred one is gone", () => {
    for (const k of keys) {
      const pick = pickByAffinity(k, conns).id;
      const rest = conns.filter((c) => c.id !== pick);
      const next = pickByAffinity(k, rest).id;
      expect(next).not.toBe(pick);
      expect(pickByAffinity(k, [...rest].reverse()).id).toBe(next);
    }
  });
});

describe("getProviderCredentials with cache-affinity", () => {
  const conns = ["a", "b", "c", "d"].map((id, i) => ({ id, provider: "claude", isActive: true, priority: i + 1 }));
  beforeEach(() => {
    getProviderConnections.mockResolvedValue(conns);
    getSettings.mockResolvedValue({ fallbackStrategy: "cache-affinity" });
  });

  it("routes a conversation to its rendezvous account and falls back when it is excluded", async () => {
    const key = deriveAffinityKey(turn1);
    const preferred = pickByAffinity(key, conns).id;
    expect((await getProviderCredentials("claude", null, "m", { affinityKey: key })).connectionId).toBe(preferred);
    const next = pickByAffinity(key, conns.filter((c) => c.id !== preferred)).id;
    expect((await getProviderCredentials("claude", new Set([preferred]), "m", { affinityKey: key })).connectionId).toBe(next);
  });
  it("falls back to fill-first without a key", async () => {
    expect((await getProviderCredentials("claude", null, "m", {})).connectionId).toBe("a");
  });
});
