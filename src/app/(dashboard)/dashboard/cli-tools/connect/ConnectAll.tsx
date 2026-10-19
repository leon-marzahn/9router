"use client";

import { useState } from "react";
import { Button, Icon } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { Dialog } from "@/ui";
import { bodyFor, settingsUrl, withV1 } from "./specs";
import { useConnectContext } from "./useConnectContext";


type Result = { id: string; name: string; ok: boolean; error?: string };

/** Point every listed tool at regent in one go: this machine, first active key, one model. */
export function ConnectAll({ tools, onClose, onDone }: { tools: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const ctx = useConnectContext();
  const [model, setModel] = useState("");
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const local = ctx.endpoints[0]?.url ?? "";

  const run = async () => {
    setRunning(true);
    const out: Result[] = [];
    for (const t of tools) {
      try {
        const res = await fetch(settingsUrl(t.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyFor(t.id, { baseUrl: withV1(local), apiKey: "", models: [model] })),
        });
        const data = await res.json().catch(() => ({}));
        out.push(res.ok ? { ...t, ok: true } : { ...t, ok: false, error: data.error?.message || data.error || `HTTP ${res.status}` });
      } catch (e) {
        out.push({ ...t, ok: false, error: (e as Error).message });
      }
      setResults([...out]);
    }
    setRunning(false);
    onDone();
  };

  return (
    <Dialog
      open
      onClose={running ? () => {} : onClose}
      dismissible={!running}
      title={`Connect ${tools.length} tool${tools.length === 1 ? "" : "s"}`}
      footer={
        results && !running ? (
          <Button variant="primary" icon="check" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={running}>
              Cancel
            </Button>
            <Button variant="primary" icon="bolt" loading={running} disabled={!model || !local} onClick={() => void run()}>
              Connect all
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-text-muted">
          Each tool gets this machine&rsquo;s address, your first active key and the model below. A backup of every file is kept, and you can change each tool afterwards.
        </p>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Model</div>
            <div className="truncate font-mono text-[12px] text-text-muted">{model || "Pick a model or combo"}</div>
          </div>
          <Button size="sm" icon="swap_horiz" disabled={running} onClick={() => setPicking(true)}>
            {model ? "Change" : "Choose"}
          </Button>
        </div>
        <ul className="space-y-1">
          {tools.map((t) => {
            const r = results?.find((x) => x.id === t.id);
            return (
              <li key={t.id} className="flex items-center gap-2 text-[13px]">
                <Icon
                  name={!r ? "radio_button_unchecked" : r.ok ? "check_circle" : "error"}
                  size={16}
                  filled={!!r}
                  className={!r ? "text-text-subtle" : r.ok ? "text-success-text" : "text-danger-text"}
                />
                <span>{t.name}</span>
                {r?.error && <span className="truncate text-[12px] text-danger-text">{r.error}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {picking && (
        <ModelSelectModal isOpen onClose={() => setPicking(false)} title="Model for all tools" closeOnSelect onSelect={(m: { value?: string }) => m?.value && setModel(m.value)} />
      )}
    </Dialog>
  );
}
