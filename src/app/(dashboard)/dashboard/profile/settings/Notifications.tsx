"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input, Segmented } from "@/ui";
import { Note, SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import { notify } from "./useSettings";

type Provider = "none" | "smtp" | "resend";
type TlsMode = "tls" | "starttls" | "none";
type TestResult = { ok: boolean; at: string; to: string; error?: string };
export type NotifyState = {
  provider: Provider;
  from: string;
  adminEmail: string;
  smtp: { host: string; port: number; tls: TlsMode; user: string; passwordConfigured: boolean };
  resend: { keyConfigured: boolean };
  ready: boolean;
  lastTest: TestResult | null;
};

const ENDPOINT = "/api/settings/notifications";

async function send(path: string, init: RequestInit) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't save");
  return data;
}

/** Settings → Notifications: where alert emails come from. Secrets are write-only. */
export function Notifications() {
  const [state, setState] = useState<NotifyState | null>(null);
  const [form, setForm] = useState({
    provider: "none" as Provider,
    from: "",
    adminEmail: "",
    smtpHost: "",
    smtpPort: "587",
    smtpTls: "starttls" as TlsMode,
    smtpUser: "",
    smtpPassword: "",
    resendKey: "",
  });
  const [busy, setBusy] = useState<null | "save" | "test">(null);

  const adopt = (n: NotifyState) => {
    setState(n);
    setForm({
      provider: n.provider,
      from: n.from,
      adminEmail: n.adminEmail,
      smtpHost: n.smtp.host,
      smtpPort: String(n.smtp.port),
      smtpTls: n.smtp.tls,
      smtpUser: n.smtp.user,
      smtpPassword: "",
      resendKey: "",
    });
  };

  useEffect(() => {
    let live = true;
    fetch(ENDPOINT, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d?.notifications) adopt(d.notifications);
      })
      .catch(() => notify().error("Couldn't load notification settings"));
    return () => {
      live = false;
    };
  }, []);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy("save");
    try {
      const body: Record<string, unknown> = {
        provider: form.provider,
        from: form.from,
        adminEmail: form.adminEmail,
      };
      if (form.provider === "smtp") {
        Object.assign(body, {
          smtpHost: form.smtpHost,
          smtpPort: Number(form.smtpPort),
          smtpTls: form.smtpTls,
          smtpUser: form.smtpUser,
        });
        if (form.smtpPassword) body.smtpPassword = form.smtpPassword;
      }
      if (form.provider === "resend" && form.resendKey) body.resendKey = form.resendKey;
      const data = await send(ENDPOINT, { method: "PATCH", body: JSON.stringify(body) });
      adopt(data.notifications);
      notify().success("Email settings saved");
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const { result } = await send(`${ENDPOINT}/test`, {
        method: "POST",
        body: JSON.stringify({ to: form.adminEmail }),
      });
      setState((s) => (s ? { ...s, lastTest: result } : s));
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection id="notifications" icon="mail" title="Notifications">
      {!state ? (
        <SettingRowSkeleton />
      ) : (
        <>
          <SettingRow
            title="Email delivery"
            hint="Budget alerts and other notices are sent by email. Pick how they leave this server."
          >
            <Segmented
              value={form.provider}
              onChange={(v) => setForm((f) => ({ ...f, provider: v }))}
              options={[
                { value: "none", label: "Off" },
                { value: "smtp", label: "SMTP" },
                { value: "resend", label: "Resend" },
              ]}
            />
          </SettingRow>
          {form.provider !== "none" && (
            <SettingRow stack title="Sender and recipient">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="From" hint="An address your provider lets you send from.">
                  <Input
                    value={form.from}
                    autoComplete="off"
                    placeholder="Alerts <alerts@example.com>"
                    onChange={set("from")}
                  />
                </Field>
                <Field label="Admin email" hint="Gets every alert, and the test email.">
                  <Input
                    type="email"
                    value={form.adminEmail}
                    autoComplete="off"
                    placeholder="you@example.com"
                    onChange={set("adminEmail")}
                  />
                </Field>
              </div>
            </SettingRow>
          )}
          {form.provider === "smtp" && (
            <SettingRow stack title="SMTP server">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Host">
                  <Input
                    value={form.smtpHost}
                    autoComplete="off"
                    placeholder="smtp.example.com"
                    onChange={set("smtpHost")}
                  />
                </Field>
                <Field label="Port">
                  <Input inputMode="numeric" value={form.smtpPort} onChange={set("smtpPort")} />
                </Field>
                <Field
                  label="Encryption"
                  className="sm:col-span-2"
                  hint={
                    form.smtpTls === "none"
                      ? "Unencrypted: the password and mail cross the network in clear text."
                      : form.smtpTls === "tls"
                        ? "TLS from the first byte (usually port 465)."
                        : "Upgrades with STARTTLS and refuses to send without it (usually port 587)."
                  }
                >
                  <Segmented
                    value={form.smtpTls}
                    onChange={(v) => setForm((f) => ({ ...f, smtpTls: v }))}
                    options={[
                      { value: "starttls", label: "STARTTLS" },
                      { value: "tls", label: "TLS" },
                      { value: "none", label: "None" },
                    ]}
                  />
                </Field>
                <Field label="User (optional)">
                  <Input value={form.smtpUser} autoComplete="off" onChange={set("smtpUser")} />
                </Field>
                <Field
                  label="Password"
                  hint={
                    state.smtp.passwordConfigured
                      ? "A password is saved. Type a new one to replace it."
                      : undefined
                  }
                >
                  <Input
                    type="password"
                    value={form.smtpPassword}
                    autoComplete="new-password"
                    placeholder={state.smtp.passwordConfigured ? "••••••••" : ""}
                    onChange={set("smtpPassword")}
                  />
                </Field>
              </div>
            </SettingRow>
          )}
          {form.provider === "resend" && (
            <SettingRow stack title="Resend">
              <Field
                label="API key"
                hint={
                  state.resend.keyConfigured
                    ? "A key is saved. Paste a new one to replace it."
                    : "Create a sending-only key in the Resend dashboard."
                }
              >
                <Input
                  type="password"
                  mono
                  value={form.resendKey}
                  autoComplete="off"
                  placeholder={state.resend.keyConfigured ? "••••••••" : "re_…"}
                  onChange={set("resendKey")}
                />
              </Field>
            </SettingRow>
          )}
          <div className="space-y-3 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                icon="save"
                loading={busy === "save"}
                onClick={() => void save()}
              >
                Save
              </Button>
              <Button
                size="sm"
                icon="send"
                disabled={!state.ready}
                loading={busy === "test"}
                onClick={() => void test()}
              >
                Send test email
              </Button>
              <span className="text-[12px] text-text-muted">
                Passwords and keys are never shown again and are left out of backups.
              </span>
            </div>
            {state.lastTest && (
              <Note tone={state.lastTest.ok ? "success" : "danger"}>
                {state.lastTest.ok
                  ? `Test sent to ${state.lastTest.to}`
                  : `Test to ${state.lastTest.to} failed: ${state.lastTest.error}`}{" "}
                · {new Date(state.lastTest.at).toLocaleString()}
              </Note>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}
