"use client";

import { useState } from "react";
import { Button, CodeBlock, Dialog, Field, IconButton, Input, Tag } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";
import { manualFiles } from "./manual";
import type { Values } from "./specs";
import { maskKey, type KeyOption } from "./useConnectContext";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

const NO_KEY = "<your regent API key>";

/**
 * The files Connect would write, to paste by hand. Built in the browser from
 * the form; the key comes from the dashboard's own key list and stays masked
 * until the user clicks "Show key". Copy puts the real key on the clipboard.
 */
export function ManualConfigDialog({
  open,
  onClose,
  toolId,
  toolName,
  values,
  apiKey,
}: {
  open: boolean;
  onClose: () => void;
  toolId: string;
  toolName: string;
  values: Values;
  /** The key picked in the form, else the first active one. */
  apiKey: KeyOption | undefined;
}) {
  const [reveal, setReveal] = useState(false);
  const close = () => {
    setReveal(false);
    onClose();
  };
  const real = apiKey?.key ?? NO_KEY;
  const shown = apiKey ? (reveal ? apiKey.key : maskKey(apiKey.key)) : NO_KEY;
  const copies = manualFiles(toolId, values, real);
  const files = manualFiles(toolId, values, shown);
  return (
    <Dialog
      open={open}
      onClose={close}
      size="xl"
      title={`Configure ${toolName} by hand`}
      description="Paste these into the files below, for example when regent runs on another machine. They match what Connect would write."
      footer={
        <Button variant="ghost" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
          <span>API key</span>
          <Tag mono tone="neutral">{apiKey ? apiKey.name : "none"}</Tag>
          {apiKey && (
            <Button size="sm" variant="ghost" icon={reveal ? "visibility_off" : "visibility"} className="ml-auto" onClick={() => setReveal(!reveal)}>
              {reveal ? "Hide key" : "Show key"}
            </Button>
          )}
        </div>
        {files.map((f, i) => (
          <CodeBlock key={f.file} title={<span className="font-mono">{f.file}</span>} copy={copies[i]?.content} copyLabel={`Copy ${f.file}`} text={f.content} wrap preClassName="max-h-72" />
        ))}
      </div>
    </Dialog>
  );
}

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;

/** Create a regent combo without leaving the tool, then hand its name back. */
export function ComboDialog({ open, onClose, onCreated, toolName }: { open: boolean; onClose: () => void; onCreated: (name: string) => void; toolName: string }) {
  const [name, setName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = name.trim();
  const error = n && !VALID_NAME.test(n) ? "Letters, digits, . - and _ only." : null;

  const reset = () => {
    setName("");
    setModels([]);
  };
  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/combos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n, models }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.error || "Couldn't create the combo");
      notify().success(`Combo "${n}" created and added`);
      onCreated(n);
      reset();
      onClose();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={`New combo for ${toolName}`}
      description="A combo tries its models in order, so the tool keeps working when one fails. It's added to the list above."
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="add" loading={busy} disabled={!n || !!error || models.length === 0} onClick={() => void create()}>
            Create combo
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" error={error} hint="What the tool sends as the model.">
          <Input mono value={name} placeholder="cowork-main" onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Models, in order</span>
            <Button size="sm" icon="add" onClick={() => setPicking(true)}>
              Add model
            </Button>
          </div>
          {models.length ? (
            <ol className="divide-y divide-border rounded-lg border border-border">
              {models.map((m, i) => (
                <li key={m} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                  <span className="w-4 text-text-subtle tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
                  <IconButton icon="close" label={`Remove ${m}`} onClick={() => setModels(models.filter((x) => x !== m))} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-text-subtle">No models yet.</p>
          )}
        </div>
      </div>
      {picking && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicking(false)}
          title="Add model to combo"
          addedModelValues={models}
          onSelect={(m: { value?: string }) => m?.value && !models.includes(m.value) && setModels((x) => [...x, m.value as string])}
          onDeselect={(m: { value?: string }) => setModels((x) => x.filter((v) => v !== m?.value))}
        />
      )}
    </Dialog>
  );
}
