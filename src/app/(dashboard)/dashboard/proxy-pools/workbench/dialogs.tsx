"use client";

import { useState, type ReactNode } from "react";
import { Button, Dialog, Field, Input, Select, SettingRow, Switch, inputClass } from "@/ui";
import { cn } from "@/ui/cn";
import { toForm, type PoolForm } from "./pools";
import type { ProxyPoolsApi } from "./useProxyPools";

/** Name / URL / no-proxy fields plus the Active and Strict switches. Shared by the dialog and the detail pane. */
export function PoolFields({
  form,
  onChange,
  disabled,
  hideActive,
}: {
  form: PoolForm;
  onChange: (next: PoolForm) => void;
  disabled?: boolean;
  /** The detail pane toggles Active from its header instead. */
  hideActive?: boolean;
}) {
  const set = (patch: Partial<PoolForm>) => onChange({ ...form, ...patch });
  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Office Proxy"
          disabled={disabled}
        />
      </Field>
      <Field label="Proxy URL">
        <Input
          mono
          value={form.proxyUrl}
          onChange={(e) => set({ proxyUrl: e.target.value })}
          placeholder="http://127.0.0.1:7897"
          disabled={disabled}
        />
      </Field>
      <Field label="No proxy" hint="Comma-separated hosts/domains to bypass proxy">
        <Input
          mono
          value={form.noProxy}
          onChange={(e) => set({ noProxy: e.target.value })}
          placeholder="localhost,127.0.0.1,.internal"
          disabled={disabled}
        />
      </Field>
      <div className="divide-y divide-border rounded-lg border border-border px-4">
        {!hideActive && (
          <SettingRow title="Active" hint="Inactive pools are ignored by runtime resolution.">
            <Switch
              label="Active"
              checked={form.isActive}
              onChange={(v) => set({ isActive: v })}
              disabled={disabled}
            />
          </SettingRow>
        )}
        <SettingRow
          title="Strict proxy"
          hint="Fail request if proxy is unreachable instead of falling back to direct."
        >
          <Switch
            label="Strict proxy"
            checked={form.strictProxy}
            onChange={(v) => set({ strictProxy: v })}
            disabled={disabled}
          />
        </SettingRow>
      </div>
    </div>
  );
}

export function NewPoolDialog({
  api,
  onClose,
  onCreated,
}: {
  api: ProxyPoolsApi;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState(toForm());
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const saved = await api.save(form);
    setSaving(false);
    if (saved) {
      onClose();
      if (saved.id) onCreated(saved.id);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add proxy pool"
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="add"
            loading={saving}
            disabled={!form.name.trim() || !form.proxyUrl.trim()}
            onClick={() => void submit()}
          >
            Add
          </Button>
        </>
      }
    >
      <PoolFields form={form} onChange={setForm} disabled={saving} />
    </Dialog>
  );
}

export function BatchImportDialog({ api, onClose }: { api: ProxyPoolsApi; onClose: () => void }) {
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const submit = async () => {
    setImporting(true);
    const done = await api.batchImport(text);
    setImporting(false);
    if (done) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Batch import proxies"
      description="Paste one proxy per line."
      dismissible={!importing}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="upload"
            loading={importing}
            disabled={!text.trim()}
            onClick={() => void submit()}
          >
            Import
          </Button>
        </>
      }
    >
      <Field
        label="Proxy list"
        hint="Supported formats: protocol://user:pass@host:port, host:port:user:pass"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
          className={cn(inputClass, "h-auto min-h-[180px] py-2 font-mono text-xs")}
          disabled={importing}
        />
      </Field>
    </Dialog>
  );
}

export type RelayKind = "cloudflare" | "vercel" | "deno" | "netlify";

interface RelayField {
  key: string;
  label: string;
  placeholder: string;
  hint: ReactNode;
  secret?: boolean;
  required?: boolean;
  initial?: string;
}

const tokenLink = (href: string) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-accent-text hover:underline"
  >
    Get token →
  </a>
);

export const RELAYS: Record<
  RelayKind,
  {
    label: string;
    icon: string;
    about: string;
    points: string[];
    steps?: { title: string; items: ReactNode[] };
    fields: RelayField[];
    deployText: string;
  }
> = {
  cloudflare: {
    label: "Cloudflare relay",
    icon: "cloud",
    about:
      "Deploys a Cloudflare Worker as a proxy relay. All AI provider requests will be forwarded through Cloudflare’s global edge network.",
    points: [
      "High performance global routing and IP masking via Cloudflare Workers",
      "Free tier: 100,000 requests per day",
      "Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)",
    ],
    steps: {
      title: "How to generate your API token",
      items: [
        <>
          Go to <b>My Profile</b> → <b>API Tokens</b> → <b>Create Token</b>
        </>,
        <>
          Scroll down to <b>Custom Token</b> and click <b>Get started</b>
        </>,
        <>
          Under <b>Permissions</b>: Account | Workers Scripts | Edit
        </>,
        <>
          Under <b>Account Resources</b>: Include | Account | <i>Your Account Name</i>
        </>,
        <>
          Click <b>Continue to summary</b> → <b>Create Token</b>
        </>,
      ],
    },
    fields: [
      {
        key: "accountId",
        label: "Account ID",
        placeholder: "your-cloudflare-account-id",
        hint: "Found on the right side of the Cloudflare dashboard overview page.",
        required: true,
      },
      {
        key: "apiToken",
        label: "API token",
        placeholder: "your-cloudflare-api-token",
        hint: (
          <>
            Requires “Workers Scripts: Edit” permission.{" "}
            {tokenLink("https://dash.cloudflare.com/profile/api-tokens")}
          </>
        ),
        secret: true,
        required: true,
      },
      {
        key: "projectName",
        label: "Worker name",
        placeholder: "my-relay",
        hint: "Unique name for your Cloudflare Worker. Leave empty for auto-generated name.",
        initial: "cloudflare-relay",
      },
    ],
    deployText: "Deploy worker",
  },
  vercel: {
    label: "Vercel relay",
    icon: "cloud_upload",
    about:
      "Deploys an edge relay function to Vercel. All AI provider requests will be forwarded through Vercel’s edge network, masking your real IP from providers.",
    points: [
      "Your IP is replaced by Vercel’s dynamic edge IPs (hundreds of IPs across 20+ global regions)",
      "Vercel serves millions of apps — providers can’t block Vercel IPs without affecting legitimate traffic",
      "Free tier: 100GB bandwidth/month, 500K edge invocations",
      "Deploy multiple relays on different accounts for more IP diversity",
    ],
    fields: [
      {
        key: "vercelToken",
        label: "Vercel API token",
        placeholder: "your-vercel-api-token",
        hint: (
          <>
            Token is used once for deployment and not stored.{" "}
            {tokenLink("https://vercel.com/account/tokens")}
          </>
        ),
        secret: true,
        required: true,
      },
      {
        key: "projectName",
        label: "Project name",
        placeholder: "my-relay",
        hint: "Unique name for your Vercel project. Leave empty for auto-generated name.",
        initial: "vercel-relay",
      },
    ],
    deployText: "Deploy (may take ~1 min)",
  },
  deno: {
    label: "Deno relay",
    icon: "terminal",
    about:
      "Deploys a relay worker to Deno Deploy’s global edge network. All AI provider requests are forwarded through Deno’s edge, masking your real IP.",
    points: [
      "Deno Deploy v2 runs on a high-performance global edge network",
      "Free tier: 1M requests & 100GiB outbound traffic per month",
      "No per-request CPU time limits (unlike Vercel/Cloudflare)",
      "Support up to 20 active apps & 50 custom domains",
      "Deploy multiple relays for maximum IP diversity",
    ],
    steps: {
      title: "How to generate an API token",
      items: [
        <>
          Go to <b>console.deno.com</b>
        </>,
        <>
          Select your <b>Organization</b> → <b>Settings</b> → <b>Organization Tokens</b>
        </>,
        <>
          Create an <b>Organization Token</b> (prefix <b>ddo_</b>)
        </>,
      ],
    },
    fields: [
      {
        key: "denoToken",
        label: "Deno Deploy API token",
        placeholder: "ddo_xxxxxxxxxxxxxxxx",
        hint: "Token is used once for deployment, not stored. Found in Organization Settings.",
        secret: true,
        required: true,
      },
      {
        key: "orgDomain",
        label: "Organization domain",
        placeholder: "your-org.deno.net",
        hint: "Organization’s default domain. Your relay URL will be in the format: https://my-relay.your-org.deno.net",
        required: true,
      },
      {
        key: "projectName",
        label: "App name",
        placeholder: "deno-relay",
        hint: "Unique app name. Leave empty for auto-generated name.",
      },
    ],
    deployText: "Deploy relay",
  },
  netlify: {
    label: "Netlify relay",
    icon: "deployed_code",
    about:
      "Deploys a serverless relay function to Netlify’s global edge network. All AI provider requests are forwarded through Netlify’s edge, masking your real IP.",
    points: [
      "Runs on Netlify Functions with a 60-second execution limit and streaming support",
      "Free tier: 125,000 function invocations and 100GB bandwidth per month",
      "Relay URL format: https://your-site.netlify.app/.netlify/functions/relay",
      "Deploy multiple relays on different accounts for more IP diversity",
    ],
    steps: {
      title: "How to generate an API token",
      items: [
        <>
          Go to <b>User Settings</b> → <b>Applications</b> → <b>Personal access tokens</b>
        </>,
        <>
          Select <b>New access token</b> and generate a token
        </>,
        <>Copy the token — you won’t see it again after leaving the page</>,
      ],
    },
    fields: [
      {
        key: "netlifyToken",
        label: "Netlify API token",
        placeholder: "nfp_xxxxxxxxxxxxxxxx",
        hint: (
          <>
            Token is used once for deployment and not stored.{" "}
            {tokenLink("https://app.netlify.com/user/applications#personal-access-tokens")}
          </>
        ),
        secret: true,
        required: true,
      },
      {
        key: "projectName",
        label: "Site name",
        placeholder: "netlify-relay",
        hint: "Unique site name (lowercase letters, numbers, hyphens). Your relay URL will be https://site-name.netlify.app/.netlify/functions/relay",
        initial: "netlify-relay",
      },
    ],
    deployText: "Deploy (may take ~1 min)",
  },
};

export const RELAY_ORDER: RelayKind[] = ["cloudflare", "vercel", "deno", "netlify"];

const blankRelayForm = (kind: RelayKind) =>
  Object.fromEntries(RELAYS[kind].fields.map((f) => [f.key, f.initial ?? ""]));

export function RelayDialog({
  api,
  initialKind,
  onClose,
}: {
  api: ProxyPoolsApi;
  initialKind: RelayKind;
  onClose: () => void;
}) {
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState<Record<string, string>>(() => blankRelayForm(initialKind));
  const [deploying, setDeploying] = useState(false);
  const r = RELAYS[kind];
  const ready = r.fields.every((f) => !f.required || form[f.key]?.trim());

  const deploy = async () => {
    setDeploying(true);
    const ok = await api.deployRelay(kind, form);
    setDeploying(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Deploy relay"
      description="Forward provider requests through an edge network so providers see its IPs, not yours."
      size="lg"
      dismissible={!deploying}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deploying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="rocket_launch"
            loading={deploying}
            disabled={!ready}
            onClick={() => void deploy()}
          >
            {deploying ? "Deploying…" : r.deployText}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Platform">
          <Select
            value={kind}
            disabled={deploying}
            onChange={(e) => {
              const next = e.target.value as RelayKind;
              setKind(next);
              setForm(blankRelayForm(next));
            }}
          >
            {RELAY_ORDER.map((k) => (
              <option key={k} value={k}>
                {RELAYS[k].label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-2 rounded-lg bg-bg-alt p-3 text-[12px] text-text-muted">
          <p>{r.about}</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {r.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {r.steps && (
            <div className="border-t border-border pt-2">
              <p className="mb-1 font-medium text-text">{r.steps.title}</p>
              <ol className="list-decimal space-y-0.5 pl-4">
                {r.steps.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
        {r.fields.map((f) => (
          <Field key={`${kind}:${f.key}`} label={f.label} hint={f.hint}>
            <Input
              type={f.secret ? "password" : "text"}
              autoComplete={f.secret ? "off" : undefined}
              value={form[f.key] ?? ""}
              placeholder={f.placeholder}
              disabled={deploying}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
