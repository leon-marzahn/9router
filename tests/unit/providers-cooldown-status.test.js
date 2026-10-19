import { describe, it, expect } from "vite-plus/test";
import {
  cooldownUntil,
  effectiveStatus,
  statsFor,
  statusFor,
} from "../../src/app/(dashboard)/dashboard/providers/model.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const in40m = new Date(NOW + 40 * 60_000).toISOString();
const ago5m = new Date(NOW - 5 * 60_000).toISOString();
const conn = (extra) => ({ id: "c", provider: "groq", authType: "apikey", ...extra });

describe("provider account cooldown status", () => {
  it("reports the latest active cooldown expiry, ignoring expired ones", () => {
    const c = conn({ modelLock_a: in40m, modelLock_b: ago5m });
    expect(cooldownUntil(c, NOW)).toBe(in40m);
    expect(cooldownUntil(conn({ rateLimitedUntil: in40m }), NOW)).toBe(in40m);
    expect(cooldownUntil(conn({ modelLock_a: ago5m }), NOW)).toBeNull();
  });

  it("is unavailable while a cooldown is active", () => {
    expect(effectiveStatus(conn({ testStatus: "unavailable", modelLock_m: in40m }), NOW)).toBe(
      "unavailable",
    );
    // A cooldown on an account last tested "active" still means rate-limited.
    expect(effectiveStatus(conn({ testStatus: "active", modelLock_m: in40m }), NOW)).toBe(
      "unavailable",
    );
    expect(effectiveStatus(conn({ testStatus: "active", rateLimitedUntil: in40m }), NOW)).toBe(
      "unavailable",
    );
  });

  it("recovers once the cooldown has expired", () => {
    expect(effectiveStatus(conn({ testStatus: "unavailable", modelLock_m: ago5m }), NOW)).toBe(
      "active",
    );
    expect(effectiveStatus(conn({ testStatus: "error", modelLock_m: in40m }), NOW)).toBe("error");
  });

  it("degrades the provider when one of its accounts is cooling down", () => {
    const future = new Date(Date.now() + 40 * 60_000).toISOString();
    const stats = statsFor([
      conn({ id: "a", testStatus: "active" }),
      conn({ id: "b", testStatus: "active", modelLock_m: future }),
    ]);
    expect(stats).toMatchObject({ total: 2, connected: 1, error: 1 });
    expect(statusFor(false, stats)).toBe("degraded");
  });
});
