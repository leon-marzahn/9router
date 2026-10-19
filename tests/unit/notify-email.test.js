// Email notifications (src/lib/notify): message validation (header injection),
// SSRF guard on the SMTP host, dedupe + rate limit, fail-safe notify(), a real SMTP
// round trip against an in-process catcher, and the settings routes never leaking secrets.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let notifyMod;
let config;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-notify-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  notifyMod = await import("@/lib/notify/index.js");
  config = await import("@/lib/notify/config.js");
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete process.env.NOTIFY_SMTP_ALLOW_PRIVATE;
});

beforeEach(() => notifyMod.resetNotifyState());

const RESEND = {
  notifyProvider: "resend",
  notifyFrom: "Alerts <alerts@example.com>",
  notifyResendKey: "re_FAKEKEY123456",
};
const okFetch = () =>
  vi.fn(async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
const req = (method, body) =>
  new Request("http://localhost/api", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Minimal SMTP catcher: accepts one session and records the DATA payload. */
function startSmtpCatcher() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let data = "";
    sock.write("220 catcher ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push(data);
            data = "";
            sock.write("250 OK queued\r\n");
          } else data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-catcher\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") sock.write("235 ok\r\n");
        else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else sock.write("250 OK\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, mails })),
  );
}

describe("message validation", () => {
  it("rejects CR/LF in subject and recipients", () => {
    const base = { to: "a@example.com", subject: "Hi", text: "body" };
    expect(() => notifyMod.validateMessage(base)).not.toThrow();
    expect(() =>
      notifyMod.validateMessage({ ...base, subject: "Hi\r\nBcc: x@evil.com" }),
    ).toThrow();
    expect(() =>
      notifyMod.validateMessage({ ...base, to: "a@example.com\nBcc: x@evil.com" }),
    ).toThrow();
    expect(() => notifyMod.validateMessage({ ...base, to: "not-an-email" })).toThrow();
  });

  it("rejects CR/LF and junk in the sender and settings", () => {
    expect(config.parseFrom("Alerts <a@example.com>")).toBe("Alerts <a@example.com>");
    expect(config.parseFrom("a@example.com\r\nBcc: x@evil.com")).toBeNull();
    expect(config.validateNotifyPatch({ from: "a@b.co\nX: y" }).error).toBeTruthy();
    expect(config.validateNotifyPatch({ adminEmail: "x\r\n@y.z" }).error).toBeTruthy();
    expect(config.validateNotifyPatch({ smtpHost: "smtp://evil/x" }).error).toBeTruthy();
    expect(config.validateNotifyPatch({ smtpPort: 70000 }).error).toBeTruthy();
    expect(config.validateNotifyPatch({ provider: "carrier-pigeon" }).error).toBeTruthy();
  });
});

describe("SMTP host SSRF guard", () => {
  it("blocks private and metadata addresses unless explicitly allowed", async () => {
    delete process.env.NOTIFY_SMTP_ALLOW_PRIVATE;
    await expect(notifyMod.resolveSmtpHost("127.0.0.1")).rejects.toThrow(/private/);
    await expect(notifyMod.resolveSmtpHost("169.254.169.254")).rejects.toThrow(/private/);
    const lookup = vi.fn(async () => ({ address: "10.0.0.5", family: 4 }));
    await expect(notifyMod.resolveSmtpHost("rebind.example.com", { lookup })).rejects.toThrow();
    const pub = vi.fn(async () => ({ address: "93.184.216.34", family: 4 }));
    expect(await notifyMod.resolveSmtpHost("smtp.example.com", { lookup: pub })).toBe(
      "93.184.216.34",
    );
    process.env.NOTIFY_SMTP_ALLOW_PRIVATE = "true";
    expect(await notifyMod.resolveSmtpHost("127.0.0.1")).toBe("127.0.0.1");
    delete process.env.NOTIFY_SMTP_ALLOW_PRIVATE;
  });
});

describe("notify()", () => {
  it("sends through Resend's fixed URL with the key as a Bearer header", async () => {
    const fetchImpl = okFetch();
    const r = await notifyMod.notify(
      { to: "a@example.com", subject: "S", text: "T" },
      { settings: RESEND, fetchImpl },
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.redirect).toBe("manual");
    expect(init.headers.Authorization).toBe("Bearer re_FAKEKEY123456");
  });

  it("de-duplicates by key", async () => {
    const fetchImpl = okFetch();
    const msg = { to: "a@example.com", subject: "S", text: "T", dedupeKey: "k1" };
    expect((await notifyMod.notify(msg, { settings: RESEND, fetchImpl })).ok).toBe(true);
    expect((await notifyMod.notify(msg, { settings: RESEND, fetchImpl })).skipped).toBe(
      "duplicate",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps total mail per hour", async () => {
    const fetchImpl = okFetch();
    for (let i = 0; i < notifyMod.RATE_LIMIT; i++) {
      await notifyMod.notify(
        { to: "a@example.com", subject: "S", text: "T" },
        { settings: RESEND, fetchImpl },
      );
    }
    const r = await notifyMod.notify(
      { to: "a@example.com", subject: "S", text: "T" },
      { settings: RESEND, fetchImpl },
    );
    expect(r.skipped).toBe("rate-limited");
    expect(fetchImpl).toHaveBeenCalledTimes(notifyMod.RATE_LIMIT);
  });

  it("never throws and never logs the secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom re_FAKEKEY123456");
    });
    const r = await notifyMod.notify(
      { to: "a@example.com", subject: "S", text: "T" },
      { settings: RESEND, fetchImpl },
    );
    expect(r.ok).toBe(false);
    const bad = await notifyMod.notify(
      { to: "a@example.com", subject: "S\nX", text: "T" },
      { settings: RESEND, fetchImpl },
    );
    expect(bad.ok).toBe(false);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain("FAKEKEY");
    warn.mockRestore();
  });

  it("skips quietly when not configured", async () => {
    const r = await notifyMod.notify(
      { to: "a@example.com", subject: "S", text: "T" },
      { settings: {} },
    );
    expect(r.skipped).toBe("not-configured");
  });

  it("delivers over SMTP to a local catcher", async () => {
    process.env.NOTIFY_SMTP_ALLOW_PRIVATE = "true";
    const { server, port, mails } = await startSmtpCatcher();
    try {
      const r = await notifyMod.notify(
        { to: "admin@example.com", subject: "Budget at 80%", text: "Key acme used $8 of $10." },
        {
          settings: {
            notifyProvider: "smtp",
            notifyFrom: "alerts@example.com",
            notifySmtpHost: "127.0.0.1",
            notifySmtpPort: port,
            notifySmtpTls: "none",
            notifySmtpUser: "u",
            notifySmtpPassword: "p",
          },
        },
      );
      expect(r).toEqual({ ok: true });
      expect(mails).toHaveLength(1);
      expect(mails[0]).toContain("Subject: Budget at 80%");
      expect(mails[0]).toContain("Key acme used $8 of $10.");
    } finally {
      server.close();
      delete process.env.NOTIFY_SMTP_ALLOW_PRIVATE;
    }
  });
});

describe("settings routes", () => {
  it("never return the SMTP password or Resend key", async () => {
    await db.updateSettings({
      notifyProvider: "smtp",
      notifyFrom: "alerts@example.com",
      notifySmtpHost: "smtp.example.com",
      notifySmtpPassword: "smtp-FAKE-secret",
      notifyResendKey: "re_FAKE-secret",
    });
    const settingsRoute = await import("@/app/api/settings/route.js");
    const text = await (await settingsRoute.GET()).text();
    expect(text).not.toContain("FAKE-secret");
    const patched = await (
      await settingsRoute.PATCH(req("PATCH", { comboStrategy: "fallback" }))
    ).text();
    expect(patched).not.toContain("FAKE-secret");

    const r = await import("@/app/api/settings/notifications/route.js");
    const res = await r.GET();
    const body = await res.text();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("FAKE-secret");
    const parsed = JSON.parse(body).notifications;
    expect(parsed.smtp.passwordConfigured).toBe(true);
    expect(parsed.resend.keyConfigured).toBe(true);

    const exported = await db.exportDb();
    expect(JSON.stringify(exported)).not.toContain("FAKE-secret");
  });

  it("PATCH /api/settings cannot mass-assign email settings", async () => {
    const settingsRoute = await import("@/app/api/settings/route.js");
    await settingsRoute.PATCH(
      req("PATCH", {
        notifySmtpHost: "evil.example.com",
        notifyResendKey: "evil",
        notifyProvider: "resend",
      }),
    );
    const s = await db.getSettings();
    expect(s.notifySmtpHost).toBe("smtp.example.com");
    expect(s.notifyResendKey).toBe("re_FAKE-secret");
    expect(s.notifyProvider).toBe("smtp");
  });

  it("PATCH validates, keeps secrets when omitted, and drops the password on a host change", async () => {
    const r = await import("@/app/api/settings/notifications/route.js");
    expect(
      (await r.PATCH(req("PATCH", { subject: "x", from: "a@b.co\r\nBcc: e@x.y" }))).status,
    ).toBe(400);
    expect((await r.PATCH(req("PATCH", { smtpPort: 2525 }))).status).toBe(200);
    expect((await db.getSettings()).notifySmtpPassword).toBe("smtp-FAKE-secret");
    await r.PATCH(req("PATCH", { smtpHost: "other.example.com" }));
    expect((await db.getSettings()).notifySmtpPassword).toBe("");
  });

  it("test route needs a valid recipient and reports failures without secrets", async () => {
    const r = await import("@/app/api/settings/notifications/test/route.js");
    expect((await r.POST(req("POST", { to: "bad\n@x" }))).status).toBe(400);
    await db.updateSettings({
      notifySmtpHost: "127.0.0.1",
      notifySmtpPassword: "smtp-FAKE-secret",
      notifyLastTest: null,
    });
    const res = await r.POST(req("POST", { to: "admin@example.com" }));
    const text = await res.text();
    expect(text).not.toContain("FAKE-secret");
    expect(JSON.parse(text).result.ok).toBe(false);
  });
});
