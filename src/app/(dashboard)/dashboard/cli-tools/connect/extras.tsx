"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, CopyButton, Field, IconButton, Input, Panel, SettingRow, Switch, Tag, Dialog } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";
import { McpMarketplace } from "./McpMarketplace";
import type { ExtrasProps } from "./specs";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

const json = (r: Response) => (r.ok ? r.json() : r.json().catch(() => ({})).then((d) => Promise.reject(new Error(d.error?.message || d.error || `HTTP ${r.status}`))));

/** A model value with a Choose / Change button and the shared model picker. */
export function ModelPick({
  value,
  onChange,
  title,
  placeholder = "Not set",
  kindFilter,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  title: string;
  placeholder?: string;
  kindFilter?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {value ? (
        <Tag mono tone="neutral" className="min-w-0 truncate">
          {value}
        </Tag>
      ) : (
        <span className="text-[12px] text-text-subtle">{placeholder}</span>
      )}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        {value ? "Change" : "Choose"}
      </Button>
      {value && <IconButton icon="close" label="Clear" disabled={disabled} onClick={() => onChange("")} />}
      {open && (
        <ModelSelectModal
          isOpen
          onClose={() => setOpen(false)}
          title={title}
          kindFilter={kindFilter}
          closeOnSelect
          onSelect={(m: { value?: string }) => m?.value && onChange(m.value)}
        />
      )}
    </div>
  );
}

/** Claude Code: filtering its topic-naming requests is a regent setting, saved right away. */
export function ClaudeExtras() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setOn(!!d?.ccFilterNaming))
      .catch(() => live && setOn(false));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (next: boolean) => {
    setOn(next);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ccFilterNaming: next }) }).then(json);
    } catch (e) {
      setOn(!next);
      notify().error((e as Error).message);
    }
  };
  return (
    <Panel className="px-4">
      <SettingRow title="Filter naming requests" hint="Answers Claude Code's topic-naming requests locally instead of spending tokens. Saved immediately, applies to every Claude Code client.">
        <Switch label="Filter naming requests" checked={!!on} disabled={on === null} onChange={(v) => void toggle(v)} />
      </SettingRow>
    </Panel>
  );
}

type Profile = { name: string; model: string; command: string };
const profileName = (model: string, taken: string[]) => {
  const base = (model.split("/").pop() || "model").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "model";
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
};

/** Codex: extra `codex -p <name>` profiles, each pinned to one model. */
export function CodexProfiles({ disabled }: ExtrasProps) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await fetch("/api/cli-tools/codex-profiles", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setProfiles((d?.profiles as Profile[]) ?? []);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const send = async (method: "POST" | "DELETE", body: object, key: string) => {
    setBusy(key);
    try {
      await fetch("/api/cli-tools/codex-profiles", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json);
      await load();
      return true;
    } catch (e) {
      notify().error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!clean || !model) return;
    if (await send("POST", { name: clean, model }, "add")) {
      setAdding(false);
      setName("");
      setModel("");
    }
  };

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium">Profiles</div>
          <p className="text-[12px] text-text-muted">Run Codex on another model with <code className="font-mono">codex -p &lt;name&gt;</code>.</p>
        </div>
        <Button size="sm" icon="add" disabled={disabled} onClick={() => setAdding(true)}>
          Add profile
        </Button>
      </div>
      {profiles === null ? null : profiles.length === 0 ? (
        <p className="text-[12px] text-text-subtle">No profiles yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {profiles.map((p) => (
            <li key={p.name} className="flex items-center gap-2 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{p.name}</span> <span className="font-mono text-text-muted">{p.model}</span>
              </span>
              <code className="hidden font-mono text-text-muted sm:inline">{p.command}</code>
              <CopyButton value={p.command} />
              <IconButton icon="delete" label={`Delete ${p.name}`} loading={busy === p.name} disabled={disabled || !!busy} onClick={() => void send("DELETE", { name: p.name }, p.name)} />
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <Field label="Model">
            <ModelPick
              value={model}
              title="Model for the profile"
              onChange={(m) => {
                setModel(m);
                if (m && !name) setName(profileName(m, (profiles ?? []).map((p) => p.name)));
              }}
            />
          </Field>
          <Field label="Name" hint="Letters, digits, - and _.">
            <Input mono value={name} placeholder="sonnet" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <Button variant="primary" icon="check" loading={busy === "add"} disabled={!name.trim() || !model} onClick={() => void add()}>
              Add
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

type Plugin = { name: string; title?: string; url?: string; oauth?: boolean; toolNames?: string[]; custom?: boolean; transport?: string };
type LocalPlugin = { name: string; title: string; description?: string; extensionUrl?: string };

/** Cowork: MCP servers written next to the gateway config. */
export function CoworkPlugins({ status, extra, setExtra, disabled }: ExtrasProps) {
  const plugins = (extra.plugins as Plugin[]) ?? [];
  const localPlugins = (extra.localPlugins as string[]) ?? [];
  const customPlugins = (extra.customPlugins as Plugin[]) ?? [];
  const defaults = (status.defaultPlugins as Plugin[]) ?? [];
  const locals = (status.localStdioPlugins as LocalPlugin[]) ?? [];
  const [market, setMarket] = useState(false);
  const [custom, setCustom] = useState<{ name: string; url: string } | null>(null);
  const set = (patch: Record<string, unknown>) => setExtra({ ...extra, ...patch });

  const exaDef = defaults.find((d) => d.name === "exa");
  const exaOn = plugins.some((p) => p.name === "exa");
  const listed = plugins.filter((p) => p.name !== "exa");
  const toggleLocal = (name: string, on: boolean) => set({ localPlugins: on ? [...localPlugins, name] : localPlugins.filter((n) => n !== name) });

  return (
    <Panel className="divide-y divide-border px-4">
      {exaDef && (
        <SettingRow title="Web search & fetch (Exa)" hint="Replaces Cowork's built-in WebSearch/WebFetch.">
          <Switch
            label="Web search & fetch (Exa)"
            checked={exaOn}
            disabled={disabled}
            onChange={(on) => set({ plugins: on ? [...listed, exaDef] : listed })}
          />
        </SettingRow>
      )}
      {locals.map((p) => (
        <SettingRow
          key={p.name}
          title={p.title}
          hint={
            <>
              {p.description} Runs locally through <code className="font-mono">npx</code>, so it needs Node.js.
              {p.extensionUrl && (
                <>
                  {" "}
                  <a href={p.extensionUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
                    Install the Chrome extension
                  </a>
                </>
              )}
            </>
          }
        >
          <Switch label={p.title} checked={localPlugins.includes(p.name)} disabled={disabled} onChange={(on) => toggleLocal(p.name, on)} />
        </SettingRow>
      ))}
      <div className="space-y-2 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-medium">MCP servers</div>
          <div className="flex gap-1.5">
            <Button size="sm" icon="storefront" disabled={disabled} onClick={() => setMarket(true)}>
              Browse
            </Button>
            <Button size="sm" icon="add" disabled={disabled} onClick={() => setCustom({ name: "", url: "" })}>
              Custom
            </Button>
          </div>
        </div>
        {listed.length + customPlugins.length === 0 ? (
          <p className="text-[12px] text-text-subtle">No MCP servers added.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {listed.map((p) => (
              <li key={p.name} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-medium">{p.title || p.name}</span>
                {p.oauth && <Tag tone="warning">OAuth</Tag>}
                {!!p.toolNames?.length && <span className="text-text-muted">{p.toolNames.length} tools</span>}
                <IconButton icon="close" label={`Remove ${p.name}`} disabled={disabled} onClick={() => set({ plugins: plugins.filter((x) => x.name !== p.name) })} />
              </li>
            ))}
            {customPlugins.map((p) => (
              <li key={p.name} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                <span className="font-medium">{p.name}</span>
                <Tag tone="info">custom</Tag>
                <span className="min-w-0 flex-1 truncate font-mono text-text-muted">{p.url}</span>
                <IconButton icon="close" label={`Remove ${p.name}`} disabled={disabled} onClick={() => set({ customPlugins: customPlugins.filter((x) => x.name !== p.name) })} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-text-subtle">Saved with the rest when you connect. Quit and reopen Claude Desktop afterwards.</p>
      </div>
      <McpMarketplace
        open={market}
        onClose={() => setMarket(false)}
        onAdd={(p: Plugin) => !plugins.some((x) => x.name === p.name) && set({ plugins: [...plugins, p] })}
        addedNames={plugins.map((p) => p.name)}
      />
      <Dialog
        open={!!custom}
        onClose={() => setCustom(null)}
        title="Add a custom MCP server"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCustom(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={!custom?.name.trim() || !custom?.url.trim()}
              onClick={() => {
                if (!custom) return;
                const name = custom.name.trim();
                set({ customPlugins: [...customPlugins.filter((x) => x.name !== name), { name, url: custom.url.trim(), transport: "sse", custom: true }] });
                setCustom(null);
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name">
            <Input mono value={custom?.name ?? ""} placeholder="my-mcp" onChange={(e) => setCustom((c) => c && { ...c, name: e.target.value.replace(/\s+/g, "-").toLowerCase() })} />
          </Field>
          <Field label="SSE URL">
            <Input mono value={custom?.url ?? ""} placeholder="https://your-mcp-server.example/sse" onChange={(e) => setCustom((c) => c && { ...c, url: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </Panel>
  );
}

type BulkResult = { profile: string; status: string; reason?: string };

/** Hermes: speech-to-text through regent, and pushing the endpoint + key to every profile. */
export function HermesExtras({ extra, setExtra, values, customEndpoint, disabled, onChanged }: ExtrasProps) {
  const [busy, setBusy] = useState(false);
  const applyAll = async () => {
    setBusy(true);
    try {
      const d = await fetch("/api/cli-tools/hermes-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applyToAll: true, baseUrl: values.baseUrl, apiKey: values.apiKey, model: values.models[0] }),
      }).then(json);
      const skipped = ((d.results as BulkResult[]) ?? []).filter((r) => r.status !== "updated");
      if (skipped.length === 0) notify().success(`Endpoint and key applied to ${d.updated} profile(s)`);
      else notify()[d.updated > 0 ? "success" : "error"](`Updated ${d.updated}, skipped ${skipped.map((r) => `${r.profile} (${r.reason || r.status})`).join(", ")}`);
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="divide-y divide-border px-4">
      <SettingRow title="Speech-to-text through regent" hint="Hermes transcribes audio with a regent speech model.">
        <Switch label="Speech-to-text through regent" checked={!!extra.audioEnabled} disabled={disabled} onChange={(on) => setExtra({ ...extra, audioEnabled: on })} />
      </SettingRow>
      {!!extra.audioEnabled && (
        <SettingRow title="Speech model">
          <ModelPick value={typeof extra.sttModel === "string" ? extra.sttModel : ""} title="Speech-to-text model" kindFilter="stt" disabled={disabled} onChange={(m) => setExtra({ ...extra, sttModel: m })} />
        </SettingRow>
      )}
      <SettingRow title="All profiles" hint="Uses the endpoint and key above (not a custom address). Writes this endpoint and key to every profile already using regent, and connects profiles without a model to the model above. Each keeps its own models.">
        <Button size="sm" icon="done_all" loading={busy} disabled={disabled || !values.baseUrl || customEndpoint} title={customEndpoint ? "Pick one of regent's endpoints first" : undefined} onClick={() => void applyAll()}>
          Apply to all profiles
        </Button>
      </SettingRow>
    </Panel>
  );
}
