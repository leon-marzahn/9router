import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { compareVersions, isEligibleUpdate, pickUpdate } from "../../src/lib/updates/version.js";
import { shouldFire, validateWebhookUrl, sendWebhook } from "../../src/lib/updates/webhook.js";
import {
  findUpdate,
  getReleases,
  updateCheckEnabled,
  _resetReleaseCache,
} from "../../src/lib/updates/releases.js";

vi.mock("@/lib/db/index.js", () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
const { runUpdateCheck } = await import("../../src/lib/updates/service.js");

describe("version comparison", () => {
  it("orders semver including prereleases", () => {
    expect(compareVersions("100.1.0", "100.0.9")).toBe(1);
    expect(compareVersions("v100.0.0", "100.0.0")).toBe(0);
    expect(compareVersions("100.0.0-rc.1", "100.0.0")).toBe(-1);
    expect(compareVersions("100.0.0-rc.10", "100.0.0-rc.2")).toBe(1);
    expect(compareVersions("101.0.0", "100.99.99")).toBe(1);
  });

  it("only newer counts; prereleases only for prerelease builds; channel keeps the major", () => {
    expect(isEligibleUpdate("100.1.0", "100.1.0")).toBe(false);
    expect(isEligibleUpdate("100.1.0", "100.0.5")).toBe(false);
    expect(isEligibleUpdate("100.1.0", "100.2.0-rc.1")).toBe(false);
    expect(isEligibleUpdate("100.2.0-rc.1", "100.2.0-rc.2")).toBe(true);
    expect(isEligibleUpdate("100.2.0-rc.1", "100.2.0")).toBe(true);
    expect(isEligibleUpdate("100.1.0", "101.0.0", { channel: "major" })).toBe(false);
    expect(isEligibleUpdate("100.1.0", "101.0.0", { channel: "any" })).toBe(true);
    expect(isEligibleUpdate("100.1.0", "garbage")).toBe(false);
  });

  it("picks the highest eligible tag per channel", () => {
    const tags = ["v101.0.0", "v100.3.0", "v100.4.0-rc.1", "v100.2.1"];
    expect(pickUpdate("100.2.0", tags, { channel: "any" })).toBe("101.0.0");
    expect(pickUpdate("100.2.0", tags, { channel: "major" })).toBe("100.3.0");
    expect(pickUpdate("101.0.0", tags, { channel: "any" })).toBeNull();
  });

  it("findUpdate returns the release notes URL", () => {
    const rel = [{ tag: "v100.3.0", url: "https://github.com/x/releases/tag/v100.3.0" }];
    expect(findUpdate(rel, "100.0.0")).toEqual({ version: "100.3.0", url: rel[0].url });
    expect(findUpdate(null, "100.0.0")).toBeNull();
  });
});

describe("release fetch", () => {
  beforeEach(() => _resetReleaseCache());

  it("can be turned off by env", () => {
    expect(updateCheckEnabled({ REGENT_UPDATE_CHECK: "false" })).toBe(false);
    expect(updateCheckEnabled({})).toBe(true);
  });

  it("caches, skips drafts, and fails silent", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { tag_name: "v100.1.0", html_url: "u" },
        { tag_name: "v100.2.0", draft: true },
      ],
    }));
    expect(await getReleases({ fetchImpl })).toEqual([{ tag: "v100.1.0", url: "u" }]);
    await getReleases({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    _resetReleaseCache();
    expect(
      await getReleases({
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  });
});

describe("webhook URL validation", () => {
  it("allows https anywhere and http only on local hosts", () => {
    expect(validateWebhookUrl("https://coolify.example.com/api/v1/deploy?uuid=1").ok).toBe(true);
    expect(validateWebhookUrl("http://example.com/hook").ok).toBe(false);
    for (const h of [
      "http://192.168.1.5:8000/h",
      "http://localhost/h",
      "http://coolify/h",
      "http://nas.lan/h",
      "http://10.0.0.2/h",
    ]) {
      expect(validateWebhookUrl(h).ok, h).toBe(true);
    }
    expect(validateWebhookUrl("ftp://x/").ok).toBe(false);
    expect(validateWebhookUrl("https://u:p@x.com/").ok).toBe(false);
    expect(validateWebhookUrl("nope").ok).toBe(false);
  });
});

describe("webhook firing rules", () => {
  const base = { url: "https://hook", current: "100.1.0", channel: "major" };
  it("fires only for newer, on-channel, not-yet-called versions", () => {
    expect(shouldFire({ ...base, candidate: "100.2.0" })).toBe(true);
    expect(shouldFire({ ...base, candidate: "100.1.0" })).toBe(false);
    expect(shouldFire({ ...base, candidate: "100.0.9" })).toBe(false);
    expect(shouldFire({ ...base, candidate: "101.0.0" })).toBe(false);
    expect(shouldFire({ ...base, channel: "any", candidate: "101.0.0" })).toBe(true);
    expect(shouldFire({ ...base, candidate: "100.2.0", lastVersion: "100.2.0" })).toBe(false);
    expect(shouldFire({ ...base, candidate: "100.3.0", lastVersion: "100.2.0" })).toBe(true);
    expect(shouldFire({ ...base, url: "", candidate: "100.2.0" })).toBe(false);
  });

  it("calls the hook once per version, even when the call failed", async () => {
    const store = {
      updateWebhookUrl: "https://hook.example/deploy",
      updateWebhookChannel: "major",
    };
    const send = vi.fn(async () => ({ ok: false, error: "Answered 500" }));
    const deps = {
      current: "100.1.0",
      getReleasesFn: async () => [
        { tag: "v100.2.0", url: "u" },
        { tag: "v101.0.0", url: "u" },
      ],
      getSettingsFn: async () => store,
      updateSettingsFn: async (p) => Object.assign(store, p),
      send,
    };
    await runUpdateCheck({ deps });
    await runUpdateCheck({ deps });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ version: "100.2.0", current: "100.1.0" });
    expect(store.updateWebhookLastVersion).toBe("100.2.0");
    expect(store.updateWebhookLastResult.ok).toBe(false);
  });

  it("posts version info only and does not follow redirects", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 302 }));
    const r = await sendWebhook(
      "https://hook.example/d",
      { version: "100.2.0", current: "100.1.0" },
      { fetchImpl },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Redirect/);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body)).toEqual({
      event: "regent.update",
      version: "100.2.0",
      current: "100.1.0",
    });
    expect(init.headers.Authorization).toBeUndefined();
    await sendWebhook(
      "https://hook.example/d",
      { version: "1", current: "1" },
      { fetchImpl, token: "t0k" },
    );
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer t0k");
  });
});
