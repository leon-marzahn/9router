"use client";

import { useState } from "react";
import { Button, CopyButton, Field, Panel } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools.js";
import { withV1 } from "./specs";
import { maskKey, useConnectContext } from "./useConnectContext";

const Picker = ModelSelectModal as unknown as React.ComponentType<Record<string, unknown>>;
const SELECT = "h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-text";

interface Step {
  step: number;
  title: string;
  desc?: string;
  value?: string;
  copyable?: boolean;
  type?: string;
}
interface GuideTool {
  name: string;
  docsUrl?: string;
  notes?: (string | { text: string })[];
  guideSteps?: Step[];
  codeBlock?: { language?: string; code: string };
}

/** Tools regent can't configure itself: pick endpoint, key and model, get the exact values to paste. */
export function PastePanel({ toolId }: { toolId: string }) {
  const tool = (CLI_TOOLS as Record<string, GuideTool>)[toolId];
  const ctx = useConnectContext();
  const [endpoint, setEndpoint] = useState("local");
  const [keyId, setKeyId] = useState("");
  const [model, setModel] = useState("");
  const [picking, setPicking] = useState(false);
  const [reveal, setReveal] = useState(false);

  const base = withV1(ctx.endpoints.find((e) => e.id === endpoint)?.url ?? "");
  const key = ctx.keys?.find((k) => k.id === keyId) ?? ctx.keys?.[0];
  const keyText = key ? (reveal ? key.key : maskKey(key.key)) : "<your regent API key>";
  const fill = (s: string, real = false) =>
    s
      .replaceAll("{{baseUrl}}", base)
      .replaceAll("{{apiKey}}", key ? (real ? key.key : keyText) : "<your regent API key>")
      .replaceAll("{{model}}", model || "<model>");

  return (
    <div className="space-y-4">
      <Panel className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Endpoint">
          <select className={SELECT} value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
            {ctx.endpoints.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="API key">
          <select className={SELECT} value={keyId || key?.id || ""} onChange={(e) => setKeyId(e.target.value)}>
            {(ctx.keys ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <Button className="w-full justify-between font-mono" onClick={() => setPicking(true)}>
            {model || "Choose…"}
          </Button>
        </Field>
      </Panel>

      <Panel className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium">Paste these into {tool?.name}</div>
          <Button size="sm" variant="ghost" icon={reveal ? "visibility_off" : "visibility"} onClick={() => setReveal(!reveal)}>
            {reveal ? "Hide key" : "Show key"}
          </Button>
        </div>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[12px]">
          {(
            [
              ["Base URL", base, base],
              ["API key", keyText, key?.key ?? ""],
              ["Model", model || "—", model],
            ] as const
          ).map(([k, shown, real]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all font-mono">{shown}</dd>
              <dd>{real ? <CopyButton value={real} /> : null}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      {tool?.guideSteps?.length ? (
        <Panel className="p-4">
          <ol className="space-y-3">
            {tool.guideSteps
              .filter((s) => !s.type)
              .map((s, i) => (
                <li key={s.step} className="flex gap-3 text-[13px]">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] tabular-nums">{i + 1}</span>
                  <div className="min-w-0 space-y-1">
                    <div className="font-medium">{s.title}</div>
                    {s.desc && <div className="text-text-muted">{fill(s.desc)}</div>}
                    {s.value && (
                      <div className="flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]">
                        <span className="min-w-0 flex-1 break-all">{fill(s.value)}</span>
                        {s.copyable && <CopyButton value={fill(s.value, true)} />}
                      </div>
                    )}
                  </div>
                </li>
              ))}
          </ol>
        </Panel>
      ) : null}

      {tool?.codeBlock && (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-1.5 text-[12px] text-text-muted">
            <span>{tool.codeBlock.language ?? "config"}</span>
            <CopyButton value={fill(tool.codeBlock.code, true)} />
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">{fill(tool.codeBlock.code)}</pre>
        </Panel>
      )}

      {tool?.docsUrl && (
        <a href={tool.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent-text hover:underline">
          {tool.name} docs
        </a>
      )}

      {picking && (
        <Picker
          isOpen
          onClose={() => setPicking(false)}
          title={`Model for ${tool?.name}`}
          closeOnSelect
          onSelect={(m: { value?: string }) => m?.value && setModel(m.value)}
        />
      )}
    </div>
  );
}
