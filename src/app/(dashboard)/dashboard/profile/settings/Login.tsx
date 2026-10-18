"use client";

import { useState } from "react";
import { Button, Field, Input, Switch } from "@/ui";
import { ConfirmModal, Modal } from "@/shared/components";
import { Note, SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import { notify, type SettingsApi } from "./useSettings";

export function Login({ api }: { api: SettingsApi }) {
  const s = api.settings;
  const [turnOff, setTurnOff] = useState(false);
  return (
    <SettingsSection id="login" icon="lock" title="Login & password">
      {!s ? (
        <>
          <SettingRowSkeleton />
          <SettingRowSkeleton />
        </>
      ) : (
        <>
          <SettingRow
            title="Require login"
            hint="Ask for the password before anyone can open this dashboard. Tunnels can't go public while it's off."
          >
            <Switch
              checked={s.requireLogin !== false}
              label="Require login"
              onChange={(v) =>
                v ? void api.save({ requireLogin: true }).catch(() => {}) : setTurnOff(true)
              }
            />
          </SettingRow>
          <PasswordForm api={api} />
          {s.hasPassword ? (
            <TurnOffWithPassword open={turnOff} onClose={() => setTurnOff(false)} api={api} />
          ) : (
            <ConfirmModal
              isOpen={turnOff}
              onClose={() => setTurnOff(false)}
              title="Turn off login?"
              message="Anyone who can reach this machine can open the dashboard and see your providers, keys and settings."
              confirmText="Turn off"
              onConfirm={() => {
                setTurnOff(false);
                void api.save({ requireLogin: false }).catch(() => {});
              }}
            />
          )}
        </>
      )}
    </SettingsSection>
  );
}

function TurnOffWithPassword({
  open,
  onClose,
  api,
}: {
  open: boolean;
  onClose: () => void;
  api: SettingsApi;
}) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPw("");
    setError(null);
    onClose();
  };
  const submit = async () => {
    setBusy(true);
    try {
      await api.save({ requireLogin: false, currentPassword: pw }, { quiet: true });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="Turn off login?"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={!pw} onClick={() => void submit()}>
            Turn off
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-text-muted">
          Anyone who can reach this machine can open the dashboard and see your providers, keys and
          settings.
        </p>
        <Field label="Your password" error={error}>
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pw && void submit()}
          />
        </Field>
      </div>
    </Modal>
  );
}

function PasswordForm({ api }: { api: SettingsApi }) {
  const has = !!api.settings?.hasPassword;
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = !!f.again && f.next !== f.again;

  const submit = async () => {
    if (f.next !== f.again) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.save({ currentPassword: f.current, newPassword: f.next }, { quiet: true });
      setF({ current: "", next: "", again: "" });
      setMsg({ tone: "success", text: "Password saved" });
      await api.reload();
      notify().success("Password saved");
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      stack
      title="Password"
      hint={
        has ? (
          "Used for the dashboard, backups, and turning off login."
        ) : (
          <Note tone="warning">
            Still the default password (123456, or INITIAL_PASSWORD if you set it). Set your own
            before going public.
          </Note>
        )
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {has && (
          <Field label="Current password" className="sm:col-span-2">
            <Input
              type="password"
              autoComplete="current-password"
              value={f.current}
              onChange={(e) => setF({ ...f, current: e.target.value })}
            />
          </Field>
        )}
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            value={f.next}
            onChange={(e) => setF({ ...f, next: e.target.value })}
          />
        </Field>
        <Field label="Repeat it" error={mismatch ? "Doesn't match" : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={f.again}
            onChange={(e) => setF({ ...f, again: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon="check"
            loading={busy}
            disabled={!f.next || f.next !== f.again || (has && !f.current)}
          >
            {has ? "Change password" : "Set password"}
          </Button>
          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        </div>
      </form>
    </SettingRow>
  );
}
