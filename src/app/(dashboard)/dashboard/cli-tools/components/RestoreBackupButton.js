"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/shared/components";

// "Restore previous": puts back the config files as they were before the last
// Apply/Reset of this tool (the rolling <file>.regent.bak backups).
export default function RestoreBackupButton({ toolId, refreshSignal, onRestored }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`/api/cli-tools/restore?toolId=${encodeURIComponent(toolId)}`);
      const data = res.ok ? await res.json() : null;
      setAvailable(!!data?.available);
    } catch {
      setAvailable(false);
    }
  }, [toolId]);

  useEffect(() => {
    void check();
  }, [check, refreshSignal]);

  const restore = async () => {
    if (!window.confirm("Restore the config files to how they were before the last Apply or Reset?")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed");
      setMessage({ ok: true, text: `Restored ${data.files.length} file(s)` });
      onRestored?.();
    } catch (error) {
      setMessage({ ok: false, text: error.message });
    } finally {
      setBusy(false);
      void check();
    }
  };

  if (!available && !message) return null;
  return (
    <div className="flex items-center gap-2">
      {available && (
        <Button variant="ghost" size="xs" icon="history" loading={busy} onClick={restore}>
          Restore previous
        </Button>
      )}
      {message && (
        <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>
      )}
    </div>
  );
}
