"use client";

import { useEffect, useRef, useState } from "react";
import { Button, CodeBlock, Field, Icon, Input } from "@/ui";
import { Modal } from "@/shared/components";

interface Check {
  installed: boolean;
  platform?: string;
  brewAvailable?: boolean;
  hasCachedPassword?: boolean;
}

/** Whether connecting can skip this dialog (installed, nothing to ask). */
export async function tailscaleReady(): Promise<Check> {
  try {
    const res = await fetch("/api/tunnel/tailscale-check");
    if (res.ok) return await res.json();
  } catch {
    /* fall through */
  }
  return { installed: false };
}

/** Install Tailscale (asking for the sudo password where the installer needs it), then connect. */
export function TailscaleSetup({
  check,
  onClose,
  onConnect,
}: {
  check: Check;
  onClose: () => void;
  onConnect: () => void;
}) {
  const [password, setPassword] = useState("");
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const needsPassword =
    check.platform !== "win32" &&
    !(check.platform === "darwin" && check.brewAvailable) &&
    !check.hasCachedPassword;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    setLog([]);
    const sudoPassword = password;
    setPassword("");
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Install failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = /^event: (.*)$/m.exec(part)?.[1]?.trim() ?? "progress";
          const raw = /^data: (.*)$/m.exec(part)?.[1];
          const data = raw ? JSON.parse(raw) : null;
          if (!data) continue;
          if (event === "progress") setLog((l) => [...l.slice(-50), data.message]);
          else if (event === "error") throw new Error(data.error || "Install failed");
          else if (event === "done") {
            onConnect();
            return;
          }
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={installing ? () => {} : onClose}
      closeOnOverlay={!installing}
      title={check.installed ? "Connect Tailscale" : "Install Tailscale"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={installing}>
            Cancel
          </Button>
          {check.installed ? (
            <Button variant="primary" icon="link" onClick={onConnect}>
              Connect
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="download"
              loading={installing}
              disabled={needsPassword && !password.trim()}
              onClick={() => void install()}
            >
              Install
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-text-muted">
          Tailscale Funnel gives this machine a fixed https address on your tailnet that stays the
          same across restarts.
        </p>
        {check.installed ? (
          <p className="flex items-center gap-2 text-success-text">
            <Icon name="check_circle" size={18} filled /> Tailscale is installed.
          </p>
        ) : (
          needsPassword && (
            <Field
              label="Your computer's password"
              hint="The installer needs admin rights. It's used for this install only."
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={installing}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && password.trim() && void install()}
              />
            </Field>
          )
        )}
        {(installing || log.length > 0) && (
          <CodeBlock preRef={logRef} text={log.join("\n") || "Starting…"} wrap muted preClassName="max-h-48 text-[11px]" />
        )}
        {error && <p className="text-danger-text">{error}</p>}
      </div>
    </Modal>
  );
}
