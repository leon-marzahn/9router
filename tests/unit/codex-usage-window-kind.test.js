import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("open-sse/utils/proxyFetch.js", async (orig) => ({ ...(await orig()), proxyAwareFetch: vi.fn() }));

const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
const { getCodexUsage } = await import("open-sse/services/usage/codex.js");

const respond = (rate_limit) =>
  proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ plan_type: "prolite", rate_limit }), { status: 200 }));
const win = (seconds, used = 0) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 1792951690 });

describe("Codex usage window classification", () => {
  afterEach(() => vi.clearAllMocks());

  it("labels a lone 7-day primary window as weekly, not 5h", async () => {
    respond({ primary_window: win(604800), secondary_window: null });
    const { quotas } = await getCodexUsage("tok");
    expect(Object.keys(quotas)).toEqual(["weekly"]);
  });

  it("keeps the usual 5h primary + weekly secondary", async () => {
    respond({ primary_window: win(18000, 40), secondary_window: win(604800, 10) });
    const { quotas } = await getCodexUsage("tok");
    expect(quotas.session.used).toBe(40);
    expect(quotas.weekly.used).toBe(10);
  });

  it("falls back to position when windows don't say their length", async () => {
    respond({ primary_window: { used_percent: 5 }, secondary_window: { used_percent: 7 } });
    const { quotas } = await getCodexUsage("tok");
    expect(quotas.session.used).toBe(5);
    expect(quotas.weekly.used).toBe(7);
  });
});
