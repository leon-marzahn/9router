"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Field, Icon, Input, Panel, Skeleton, Tag } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { ConfirmDialog } from "@/ui";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";
import { SPECS, bodyFor, settingsUrl, withV1 } from "./specs";
import { maskKey, useConnectContext } from "./useConnectContext";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

export interface ToolStatus {
  installed?: boolean;
  hasRegent?: boolean;
  current?: { baseUrl: string | null; hasKey: boolean; models: Record<string, string | string[] | null> } | null;
}

const SELECT = "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-text";

/** Endpoint, key and model for one tool, a preview of what gets written, and Connect / Disconnect / Restore. */
export function ConnectPanel({ toolId, toolName, onChanged }: { toolId: string; toolName: string; onChanged: () => void }) {
  const spec = SPECS[toolId];
  const ctx = useConnectContext();
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [endpoint, setEndpoint] = useState<string>("local");
  const [custom, setCustom] = useState("");
  const [keyId, setKeyId] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<null | "apply" | "remove" | "restore">(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [canRestore, setCanRestore] = useState(false);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      fetch(settingsUrl(toolId), { cache: "no-store" }).then((x) => (x.ok ? x.json() : {})).catch(() => ({})),
      fetch(`/api/cli-tools/restore?toolId=${encodeURIComponent(toolId)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
    ]);
    setStatus(s as ToolStatus);
    setCanRestore(!!r?.available);
    const cur = (s as ToolStatus).current;
    if (cur) {
      const m = cur.models?.models ?? cur.models?.model;
      setModels(Array.isArray(m) ? m.filter(Boolean) as string[] : m ? [m] : []);
    }
  }, [toolId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Match the written base URL to a known endpoint, else show it as custom.
  const currentBase = status?.current?.baseUrl ?? null;
  useEffect(() => {
    if (!currentBase) return;
    const match = ctx.endpoints.find((e) => e.url && withV1(e.url) === withV1(currentBase));
    const t = setTimeout(() => {
      if (match) setEndpoint(match.id);
      else {
        setEndpoint("custom");
        setCustom(currentBase);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [currentBase, ctx.endpoints.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = endpoint === "custom" ? custom.trim() : (ctx.endpoints.find((e) => e.id === endpoint)?.url ?? "");
  const key = ctx.keys?.find((k) => k.id === keyId);
  const connected = !!status?.hasRegent;
  const ready = !!base && models.length > 0;

  const apply = async () => {
    setBusy("apply");
    try {
      const res = await fetch(settingsUrl(toolId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFor(toolId, { baseUrl: withV1(base), apiKey: key?.key ?? "", models })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.error || "Couldn't write the settings");
      notify().success(`${toolName} now uses regent`);
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    setBusy("remove");
    try {
      const res = await fetch(settingsUrl(toolId), { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.error || "Couldn't remove the settings");
      notify().success(`Removed regent from ${toolName}`);
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      const res = await fetch("/api/cli-tools/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed");
      notify().success(`Restored ${data.files?.length ?? 0} file(s) to how they were before`);
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!status || !ctx.keys)
    return (
      <Panel className="space-y-3 p-4">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-2/3 rounded-lg" />
      </Panel>
    );

  if (status.installed === false)
    return (
      <Panel className="p-4 text-[13px] text-text-muted">
        {toolName} isn&rsquo;t installed on this machine, so there&rsquo;s nothing to connect yet. Install it, then come back.
      </Panel>
    );

  const preview: [string, string][] = [
    ["Base URL", base ? withV1(base) : "—"],
    ["API key", key ? `${key.name} (${maskKey(key.key)})` : status.current?.hasKey ? "keep the one already there" : "your first active key"],
    [spec.multi ? "Models" : "Model", models.length ? models.join(", ") : "—"],
  ];

  return (
    <div className="space-y-4">
      <Panel className="divide-y divide-border px-4">
        <div className="grid gap-3 py-4 sm:grid-cols-2">
          <Field label="Endpoint" hint="Where the tool sends requests.">
            <select className={SELECT} value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
              {ctx.endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} · {e.url.replace(/^https?:\/\//, "")}
                </option>
              ))}
              <option value="custom">Custom address…</option>
            </select>
          </Field>
          <Field label="API key" hint="The regent key the tool uses.">
            <select className={SELECT} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">{status.current?.hasKey ? "Keep current key" : "First active key"}</option>
              {ctx.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
          {endpoint === "custom" && (
            <Field label="Custom address" className="sm:col-span-2">
              <Input mono value={custom} placeholder="https://regent.example.com" onChange={(e) => setCustom(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="space-y-2 py-4">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">{spec.multi ? "Models" : "Model"}</div>
            <Button size="sm" icon={spec.multi ? "add" : "swap_horiz"} onClick={() => setPicking(true)}>
              {spec.multi ? "Add model" : models.length ? "Change" : "Choose"}
            </Button>
          </div>
          {models.length ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((m, i) => (
                <Tag key={m} mono tone={i === 0 ? "accent" : "neutral"} className="gap-0.5 pr-1">
                  {m}
                  {spec.multi && (
                    <button type="button" aria-label={`Remove ${m}`} onClick={() => setModels(models.filter((x) => x !== m))} className="grid size-4 place-items-center rounded hover:bg-surface-3">
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </Tag>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-muted">Pick a model or combo from regent for {toolName} to use.</p>
          )}
          {spec.multi && models.length > 1 && <p className="text-[11px] text-text-subtle">The first one is the default.</p>}
        </div>
      </Panel>

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-[12px]">
          <span className="min-w-0 truncate text-text-muted">Written to {spec.file}</span>
          <Tag tone={connected ? "success" : "neutral"}>{connected ? "Currently connected" : "Not connected yet"}</Tag>
        </div>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 p-4 text-[12px]">
          {preview.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="check" loading={busy === "apply"} disabled={!ready || !!busy} onClick={() => void apply()}>
          {connected ? "Update" : "Connect"}
        </Button>
        {connected && (
          <Button variant="ghost" icon="link_off" disabled={!!busy} loading={busy === "remove"} onClick={() => setConfirmRemove(true)}>
            Disconnect
          </Button>
        )}
        {canRestore && (
          <Button variant="ghost" icon="history" disabled={!!busy} loading={busy === "restore"} onClick={() => void restore()}>
            Restore previous
          </Button>
        )}
        <span className="text-[11px] text-text-subtle">A backup of the file is kept before every change.</span>
      </div>

      {picking && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicking(false)}
          title={`Model for ${toolName}`}
          closeOnSelect={!spec.multi}
          addedModelValues={spec.multi ? models : []}
          onSelect={(m: { value?: string }) => {
            if (!m?.value) return;
            setModels(spec.multi ? (models.includes(m.value) ? models : [...models, m.value]) : [m.value]);
          }}
          onDeselect={(m: { value?: string }) => spec.multi && setModels(models.filter((x) => x !== m?.value))}
        />
      )}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Disconnect ${toolName}?`}
        message={`Removes regent's settings from ${toolName}'s config, so it goes back to its own provider. A backup is kept, so you can restore it.`}
        confirmText="Disconnect"
        onConfirm={() => void remove()}
      />
    </div>
  );
}
