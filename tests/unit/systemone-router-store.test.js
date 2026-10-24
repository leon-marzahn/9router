// Smart Router helpers: what is sent to the router (latest user text, capped) and the
// bounded in-memory sticky store (TTL, memory ceiling, per-combo clearing).
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import {
  extractPromptState,
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  resetStickyComboStore,
  MAX_STICKY_SESSIONS,
  STICKY_SESSION_TTL_MS,
} from "../../open-sse/services/systemoneRouter.js";

afterEach(() => {
  vi.useRealTimers();
  resetStickyComboStore();
});

describe("extractPromptState", () => {
  it("falls back to the last message of any role, then prompt / input strings", () => {
    expect(extractPromptState({ messages: [{ role: "assistant", content: [{ type: "text", text: " hi " }] }] })).toBe("hi");
    expect(extractPromptState({ prompt: "  draw a cat " })).toBe("draw a cat");
    expect(extractPromptState({ input: " translate this " })).toBe("translate this");
    expect(extractPromptState({ input: [{ type: "message", content: ["plain", { type: "image" }] }] })).toBe("plain");
    expect(extractPromptState(null)).toBe("");
    expect(extractPromptState({ messages: [] })).toBe("");
  });

  it("caps what the router sees", () => {
    expect(extractPromptState({ prompt: "x".repeat(5000) })).toHaveLength(2000);
  });
});

describe("sticky store", () => {
  it("expires a pick after the TTL and drops one whose model left the combo", () => {
    vi.useFakeTimers();
    setStickyComboModel("c", "s", "a/one");
    expect(getStickyComboModel("c", "s", ["a/one"])).toBe("a/one");
    expect(getStickyComboModel("c", "s", ["b/two"])).toBeNull();
    setStickyComboModel("c", "s", "a/one");
    vi.advanceTimersByTime(STICKY_SESSION_TTL_MS + 1);
    expect(getStickyComboModel("c", "s", ["a/one"])).toBeNull();
  });

  it("clears one session, one combo, or everything", () => {
    setStickyComboModel("c1", "s1", "m");
    setStickyComboModel("c1", "s2", "m");
    setStickyComboModel("c2", "s1", "m");
    clearStickyComboSession("c1", "s1");
    expect(getStickyComboModel("c1", "s1", ["m"])).toBeNull();
    clearStickyComboSession("c1");
    expect(getStickyComboModel("c1", "s2", ["m"])).toBeNull();
    expect(getStickyComboModel("c2", "s1", ["m"])).toBe("m");
    clearStickyComboSession();
    expect(getStickyComboModel("c2", "s1", ["m"])).toBeNull();
  });

  it("stays bounded: expired picks go first, then the oldest quarter", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_STICKY_SESSIONS; i++) setStickyComboModel("c", `old-${i}`, "m");
    // All expire; the next write prunes them.
    vi.advanceTimersByTime(STICKY_SESSION_TTL_MS + 1);
    setStickyComboModel("c", "fresh", "m");
    expect(getStickyComboModel("c", "old-0", ["m"])).toBeNull();
    expect(getStickyComboModel("c", "fresh", ["m"])).toBe("m");

    // Fill to the ceiling with live picks: the oldest quarter is dropped.
    for (let i = 0; i < MAX_STICKY_SESSIONS; i++) {
      vi.advanceTimersByTime(1);
      setStickyComboModel("c", `live-${i}`, "m");
    }
    setStickyComboModel("c", "newest", "m");
    expect(getStickyComboModel("c", "newest", ["m"])).toBe("m");
    expect(getStickyComboModel("c", `live-${MAX_STICKY_SESSIONS - 1}`, ["m"])).toBe("m");
    expect(getStickyComboModel("c", "fresh", ["m"])).toBeNull();
  });
});
