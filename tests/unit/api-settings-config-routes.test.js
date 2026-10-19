// Settings, combos, pricing and disabled-models dashboard routes against a real DB in a
// per-file temp DATA_DIR: secrets stay out of responses, protected keys can't be
// mass-assigned, and malformed payloads are rejected with 400.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-api-settings-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const req = (method, body, url = "http://localhost/api") =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });

describe("/api/settings secrets", () => {
  it("GET and PATCH responses omit the password hash, OIDC secret and redeploy hook", async () => {
    const r = await import("@/app/api/settings/route.js");
    await db.updateSettings({
      password: "$2a$10$FAKEHASHFAKEHASHFAKEHASHFAKEHASHFAKEHASHFAKEHASHFAKE",
      oidcIssuerUrl: "https://idp.example",
      oidcClientId: "cid",
      oidcClientSecret: "oidc-FAKE-secret",
      updateWebhookUrl: "https://hooks.example/deploy/FAKE-token",
      updateWebhookToken: "hook-FAKE-token",
    });

    const getRes = await r.GET();
    expect(getRes.headers.get("cache-control")).toBe("no-store");
    const text = await getRes.text();
    for (const s of ["FAKEHASH", "oidc-FAKE-secret", "FAKE-token"]) expect(text).not.toContain(s);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ hasPassword: true, oidcConfigured: true, updateWebhookSet: true, updateWebhookHost: "hooks.example" });

    const patchText = await (await r.PATCH(req("PATCH", { comboStrategy: "round-robin" }))).text();
    for (const s of ["FAKEHASH", "oidc-FAKE-secret", "FAKE-token"]) expect(patchText).not.toContain(s);
  });

  it("PATCH cannot mass-assign protected keys", async () => {
    const r = await import("@/app/api/settings/route.js");
    const before = await db.getSettings();
    const res = await r.PATCH(req("PATCH", {
      password: "attacker-hash",
      mitmSudoEncrypted: "attacker-cipher",
      updateWebhookUrl: "https://evil.example/hook",
      updateWebhookToken: "evil",
    }));
    expect(res.status).toBe(200);
    const after = await db.getSettings();
    expect(after.password).toBe(before.password);
    expect(after.mitmSudoEncrypted).toBe(before.mitmSudoEncrypted);
    expect(after.updateWebhookUrl).toBe(before.updateWebhookUrl);
    expect(after.updateWebhookToken).toBe(before.updateWebhookToken);
  });

  it("PATCH password change requires the current password and stores only a hash", async () => {
    const r = await import("@/app/api/settings/route.js");
    const bcrypt = (await import("bcryptjs")).default;
    await db.updateSettings({ password: await bcrypt.hash("old-pass", 4) });

    expect((await r.PATCH(req("PATCH", { newPassword: "new-pass" }))).status).toBe(400);
    expect((await r.PATCH(req("PATCH", { newPassword: "new-pass", currentPassword: "wrong" }))).status).toBe(401);
    expect((await r.PATCH(req("PATCH", { newPassword: "new-pass", currentPassword: "old-pass" }))).status).toBe(200);
    const s = await db.getSettings();
    expect(s.password).not.toBe("new-pass");
    expect(await bcrypt.compare("new-pass", s.password)).toBe(true);
    expect(s).not.toHaveProperty("newPassword");
    expect(s).not.toHaveProperty("currentPassword");
  });

  // BUG (security): GET /api/settings strips password/oidcClientSecret/updateWebhook*
  // but not `mitmSudoEncrypted` — the host's sudo password, AES-GCM encrypted with a key
  // derived from the machine id + a constant salt (src/mitm/manager.js deriveKey; constant
  // salt alone if node-machine-id fails). Any dashboard session (or anyone, with
  // requireLogin off) receives the ciphertext; whoever can read the machine id can decrypt it.
  // Fix: drop it in toPublicSettings (src/app/api/settings/route.js). Un-skip once fixed.
  it.skip("GET does not return the encrypted MITM sudo password", async () => {
    const r = await import("@/app/api/settings/route.js");
    await db.updateSettings({ mitmSudoEncrypted: "aa:bb:FAKE-cipher" });
    const text = await (await r.GET()).text();
    expect(text).not.toContain("FAKE-cipher");
  });
});

describe("/api/combos", () => {
  it("validates names, rejects duplicates, renames carry per-combo strategy", async () => {
    const r = await import("@/app/api/combos/route.js");
    const one = await import("@/app/api/combos/[id]/route.js");

    expect((await r.POST(req("POST", {}))).status).toBe(400);
    expect((await r.POST(req("POST", { name: "bad name!" }))).status).toBe(400);
    const res = await r.POST(req("POST", { name: "fast", models: ["cc/a"] }));
    expect(res.status).toBe(201);
    const combo = await res.json();
    expect((await r.POST(req("POST", { name: "fast" }))).status).toBe(400);
    await r.POST(req("POST", { name: "other" }));

    expect((await (await r.GET()).json()).combos.map((c) => c.name)).toEqual(expect.arrayContaining(["fast", "other"]));
    expect((await one.GET(req("GET"), ctx("missing"))).status).toBe(404);
    expect((await (await one.GET(req("GET"), ctx(combo.id))).json()).name).toBe("fast");

    expect((await one.PUT(req("PUT", { name: "a b" }), ctx(combo.id))).status).toBe(400);
    expect((await one.PUT(req("PUT", { name: "other" }), ctx(combo.id))).status).toBe(400);
    expect((await one.PUT(req("PUT", { models: [] }), ctx("missing"))).status).toBe(404);

    await db.updateSettings({ comboStrategies: { fast: { fallbackStrategy: "round-robin" } } });
    const renamed = await (await one.PUT(req("PUT", { name: "faster" }), ctx(combo.id))).json();
    expect(renamed.name).toBe("faster");
    const { comboStrategies } = await db.getSettings();
    expect(comboStrategies.faster).toEqual({ fallbackStrategy: "round-robin" });
    expect(comboStrategies.fast).toBeUndefined();

    expect((await one.DELETE(req("DELETE"), ctx(combo.id))).status).toBe(200);
    expect((await one.DELETE(req("DELETE"), ctx(combo.id))).status).toBe(404);
  });
});

describe("/api/pricing", () => {
  it.each([
    [null],
    [{ p: "x" }],
    [{ p: { m: 3 } }],
    [{ p: { m: { bogus: 1 } } }],
    [{ p: { m: { input: -1 } } }],
    [{ p: { m: { input: "1" } } }],
  ])("PATCH rejects %j", async (body) => {
    const r = await import("@/app/api/pricing/route.js");
    expect((await r.PATCH(req("PATCH", body))).status).toBe(400);
  });

  it("PATCH merges, DELETE resets per model / provider / all", async () => {
    const r = await import("@/app/api/pricing/route.js");
    const after = await (await r.PATCH(req("PATCH", { zzp: { m1: { input: 1, output: 2 }, m2: { input: 3 } } }))).json();
    expect(after.zzp.m1).toMatchObject({ input: 1, output: 2 });
    expect((await (await r.GET()).json()).zzp.m2.input).toBe(3);

    let p = await (await r.DELETE(req("DELETE", undefined, "http://localhost/api/pricing?provider=zzp&model=m1"))).json();
    expect(p.zzp?.m1?.input).not.toBe(1);
    p = await (await r.DELETE(req("DELETE", undefined, "http://localhost/api/pricing?provider=zzp"))).json();
    expect(p.zzp?.m2?.input).not.toBe(3);
    await r.PATCH(req("PATCH", { zzp: { m3: { input: 9 } } }));
    p = await (await r.DELETE(req("DELETE", undefined, "http://localhost/api/pricing"))).json();
    expect(p.zzp?.m3?.input).not.toBe(9);
  });
});

describe("/api/models/disabled", () => {
  it("validates input and round-trips disable/enable", async () => {
    const r = await import("@/app/api/models/disabled/route.js");
    expect((await r.POST(req("POST", { providerAlias: "cc" }))).status).toBe(400);
    expect((await r.POST(req("POST", { ids: ["a"] }))).status).toBe(400);
    expect((await r.DELETE(req("DELETE", undefined, "http://localhost/api/models/disabled"))).status).toBe(400);

    await r.POST(req("POST", { providerAlias: "cc", ids: ["a", "b"] }));
    expect(await (await r.GET(req("GET", undefined, "http://localhost/api/models/disabled?providerAlias=cc"))).json()).toEqual({ ids: ["a", "b"] });
    await r.DELETE(req("DELETE", undefined, "http://localhost/api/models/disabled?providerAlias=cc&id=a"));
    expect((await (await r.GET(req("GET", undefined, "http://localhost/api/models/disabled"))).json()).disabled).toEqual({ cc: ["b"] });
    await r.DELETE(req("DELETE", undefined, "http://localhost/api/models/disabled?providerAlias=cc"));
    expect(await (await r.GET(req("GET", undefined, "http://localhost/api/models/disabled?providerAlias=cc"))).json()).toEqual({ ids: [] });
  });
});
