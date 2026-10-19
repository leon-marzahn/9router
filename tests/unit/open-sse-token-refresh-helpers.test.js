import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import {
  isUnrecoverableRefreshError,
  getRefreshLeadMs,
  parseVertexSaJson,
  refreshWithRetry,
  TOKEN_EXPIRY_BUFFER_MS,
} from "../../open-sse/services/tokenRefresh.js";

describe("open-sse tokenRefresh helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("classifies only revoked/invalid grants as unrecoverable", () => {
    for (const error of ["unrecoverable_refresh_error", "refresh_token_reused", "invalid_request", "invalid_grant"]) {
      expect(isUnrecoverableRefreshError({ error })).toBe(true);
    }
    for (const r of [null, undefined, "invalid_grant", { error: "rate_limited" }, { accessToken: "x" }]) {
      expect(Boolean(isUnrecoverableRefreshError(r))).toBe(false);
    }
  });

  it("falls back to the default lead time for unknown providers", () => {
    expect(getRefreshLeadMs("no-such-provider")).toBe(TOKEN_EXPIRY_BUFFER_MS);
    expect(getRefreshLeadMs("kimi-coding")).toBe(getRefreshLeadMs("kimi"));
  });

  it("parses only complete service-account JSON", () => {
    const sa = { type: "service_account", client_email: "a@b", private_key: "k", project_id: "p" };
    expect(parseVertexSaJson(JSON.stringify(sa))).toEqual(sa);
    expect(parseVertexSaJson(JSON.stringify({ ...sa, type: "authorized_user" }))).toBe(null);
    expect(parseVertexSaJson(JSON.stringify({ ...sa, private_key: "" }))).toBe(null);
    expect(parseVertexSaJson("AIza-plain-key")).toBe(null);
    expect(parseVertexSaJson(undefined)).toBe(null);
  });

  it("refreshWithRetry retries throws/falsy results with backoff, then gives up", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(null).mockResolvedValueOnce({ ok: 1 });
    const p = refreshWithRetry(fn, 3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledTimes(3);

    const never = vi.fn().mockResolvedValue(null);
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const p2 = refreshWithRetry(never, 2, log);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p2).toBe(null);
    expect(never).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalled();
  });
});
