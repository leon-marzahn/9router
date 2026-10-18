// The redeploy hook URL embeds a deploy token: it must never reach the browser
// (GET/PATCH /api/settings) or a backup file, and a restore must not replace it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const HOOK = "https://coolify.example.com/api/v1/deploy?uuid=abc&token=SECRET123";

describe("redeploy hook secrecy", () => {
  afterEach(() => vi.doUnmock("@/lib/localDb"));

  it("GET and PATCH /api/settings return only set + host", async () => {
    vi.resetModules();
    const store = {
      current: { updateWebhookUrl: HOOK, updateWebhookToken: "TOKEN456", theme: "dark" },
    };
    vi.doMock("@/lib/localDb", () => ({
      getSettings: async () => store.current,
      updateSettings: async (p) => (store.current = { ...store.current, ...p }),
    }));
    vi.doMock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: () => {} }));
    vi.doMock("open-sse/services/combo.js", () => ({ resetComboRotation: () => {} }));
    const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toContain("SECRET123");
    expect(JSON.stringify(body)).not.toContain("TOKEN456");
    expect(body.updateWebhookSet).toBe(true);
    expect(body.updateWebhookHost).toBe("coolify.example.com");

    const res = await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({
          updateWebhookUrl: "https://evil.example/x",
          updateWebhookLastVersion: "999.0.0",
        }),
      }),
    );
    expect(JSON.stringify(await res.json())).not.toContain("SECRET123");
    expect(store.current.updateWebhookUrl).toBe(HOOK);
    expect(store.current.updateWebhookLastVersion).toBeUndefined();
  });

  it("the DB export leaves it out and an import keeps the current one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-hook-"));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    try {
      delete global._dbAdapter;
      vi.resetModules();
      const db = await import("@/lib/db/index.js");
      await db.updateSettings({
        updateWebhookUrl: HOOK,
        updateWebhookToken: "TOKEN456",
        updateWebhookLastVersion: "100.2.0",
        theme: "dark",
      });
      const dump = await db.exportDb();
      expect(JSON.stringify(dump)).not.toContain("SECRET123");
      expect(JSON.stringify(dump)).not.toContain("TOKEN456");
      expect(dump.settings.theme).toBe("dark");

      await db.importDb({
        ...dump,
        settings: { ...dump.settings, updateWebhookUrl: "https://evil.example/x" },
      });
      const after = await db.getSettings();
      expect(after.updateWebhookUrl).toBe(HOOK);
      expect(after.updateWebhookLastVersion).toBe("100.2.0");
      expect(after.updateWebhookToken).toBe("TOKEN456");
    } finally {
      try {
        global._dbAdapter?.instance?.close?.();
      } catch {}
      delete global._dbAdapter;
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
    }
  });
});

describe("/api/settings/updates", () => {
  it("never returns the URL or token, and a new URL drops the old token", async () => {
    vi.resetModules();
    const store = { current: { updateWebhookUrl: HOOK, updateWebhookToken: "TOKEN456" } };
    vi.doMock("@/lib/db/index.js", () => ({
      getSettings: async () => store.current,
      updateSettings: async (p) => (store.current = { ...store.current, ...p }),
    }));
    vi.doMock("@/lib/updates/releases.js", async (orig) => ({
      ...(await orig()),
      getReleases: async () => null,
    }));
    const { GET, PATCH } = await import("../../src/app/api/settings/updates/route.js");
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("TOKEN456");

    const req = (body) => new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });
    expect((await PATCH(req({ url: "http://example.com/hook" }))).status).toBe(400);
    const res = await PATCH(req({ url: "https://other.example/hook" }));
    expect(res.status).toBe(200);
    expect(store.current.updateWebhookToken).toBe("");
    const out = await res.json();
    expect(out.webhook).toMatchObject({ set: true, host: "other.example", hasToken: false });
    vi.doUnmock("@/lib/db/index.js");
    vi.doUnmock("@/lib/updates/releases.js");
  });
});
