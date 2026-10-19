"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Button,
  Field,
  Icon,
  Input,
  Panel,
  SectionTitle,
  Skeleton,
  StatusLabel,
  Switch,
} from "@/ui";
import { cn } from "@/ui/cn";
import { ConfirmDialog, Dialog } from "@/ui";
import { CopyButton } from "@/ui";
import { KeyCard } from "./KeyCard";
import { TailscaleSetup, tailscaleReady } from "./TailscaleSetup";
import { useEndpoint, type Security } from "./useEndpoint";
import { useTunnels, type TunnelKind, type TunnelState } from "./useTunnels";

const noop = () => () => {};

type Confirm = {
  title: string;
  message: string;
  confirmText: string;
  icon?: string;
  danger?: boolean;
  run: () => void;
};

/** What still blocks going public. Mirrors the server check in lib/tunnel/exposureGuard. */
function gates(s: Security) {
  return [
    { label: "Require login", ok: s.requireLogin, fix: "/dashboard/profile" },
    { label: "Password changed from default", ok: s.hasPassword, fix: "/dashboard/profile" },
    { label: "Require API key", ok: s.requireApiKey, fix: "#require-api-key" },
  ];
}

export function Gatehouse() {
  const ep = useEndpoint();
  const tn = useTunnels();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [creating, setCreating] = useState(false);
  const [tsSetup, setTsSetup] = useState<Awaited<ReturnType<typeof tailscaleReady>> | null>(null);
  const origin = useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => "",
  );

  const sec = ep.security;
  const safe = !!sec && gates(sec).every((g) => g.ok);
  const cf = tn.state.cloudflare;
  const ts = tn.state.tailscale;
  const exposed =
    cf.phase === "on" || cf.phase === "starting" || ts.phase === "on" || ts.phase === "starting";

  const turnOn = async (kind: TunnelKind) => {
    if (kind === "cloudflare") return void tn.startCloudflare();
    const check = await tailscaleReady();
    if (check.installed) void tn.startTailscale();
    else setTsSetup(check);
  };
  const turnOff = (kind: TunnelKind, name: string) =>
    setConfirm({
      title: `Turn off ${name}?`,
      message: "Apps using this URL lose access until you turn it back on.",
      confirmText: "Turn off",
      icon: "power_settings_new",
      danger: true,
      run: () => void tn.stop(kind),
    });

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Endpoint</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          The address apps use to reach the gateway, who can reach it, and the keys that let them
          in.
        </p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="min-w-0 space-y-4">
          <SectionTitle icon="shield" title="Who can reach it" />
          <Panel className={cn("p-4", exposed && !safe && "border-warning/60")}>
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-full",
                  exposed ? "bg-accent-soft text-accent" : "bg-surface-2 text-text-muted",
                )}
              >
                <Icon name={exposed ? "public" : "home"} size={20} />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium">
                  {exposed ? "Reachable from the internet" : "Only your network"}
                </div>
                <div className="text-[12px] text-text-muted">
                  {exposed
                    ? "Anyone with the URL and a key"
                    : "Turn on a tunnel to use it away from home"}
                </div>
              </div>
            </div>
            <ul className="mt-4 space-y-1.5 border-t border-border pt-4">
              {sec
                ? gates(sec).map((g) => (
                    <li key={g.label} className="flex items-center gap-2 text-[13px]">
                      <Icon
                        name={g.ok ? "check_circle" : "error"}
                        size={16}
                        filled
                        className={g.ok ? "text-success-text" : "text-warning-text"}
                      />
                      <span className={g.ok ? "text-text-muted" : ""}>{g.label}</span>
                      {!g.ok && (
                        <Link
                          href={g.fix}
                          className="ml-auto text-[12px] text-accent-text hover:underline"
                        >
                          Fix
                        </Link>
                      )}
                    </li>
                  ))
                : [0, 1, 2].map((i) => <Skeleton key={i} className="h-5 w-48" />)}
            </ul>
            {!safe && sec && (
              <p className="mt-3 text-[12px] text-text-muted">
                Tunnels stay locked until all three are on.
              </p>
            )}
          </Panel>

          <ol className="space-y-3">
            <Way icon="computer" name="This machine" on>
              <UrlLine url={origin ? `${origin}/v1` : ""} />
            </Way>
            <TunnelWay
              icon="public"
              name="Public URL"
              blurb="Cloudflare tunnel, reachable from anywhere. The address changes when it restarts."
              t={cf}
              locked={!safe}
              onStart={() => void turnOn("cloudflare")}
              onStop={() =>
                cf.phase === "starting"
                  ? void tn.stop("cloudflare")
                  : turnOff("cloudflare", "the public URL")
              }
            />
            <TunnelWay
              icon="lan"
              name="Tailnet"
              blurb="Tailscale Funnel, a fixed address that survives restarts."
              t={ts}
              locked={!safe}
              onStart={() => void turnOn("tailscale")}
              onStop={() =>
                ts.phase === "starting"
                  ? void tn.stop("tailscale")
                  : turnOff("tailscale", "Tailscale")
              }
            />
          </ol>

          {sec && (cf.phase === "on" || ts.phase === "on") && (
            <Panel className="flex items-start justify-between gap-3 p-4 text-[13px]">
              <div>
                <div>Dashboard over the tunnel</div>
                <div className="text-[12px] text-text-subtle">
                  Open this dashboard from the public address too. Login is still required.
                </div>
              </div>
              <Switch
                checked={sec.tunnelDashboardAccess}
                onChange={(v) => void ep.setSetting({ tunnelDashboardAccess: v })}
                label="Dashboard over the tunnel"
              />
            </Panel>
          )}
        </section>

        <section className="min-w-0 space-y-4" id="require-api-key">
          <SectionTitle
            icon="key"
            title="Keys"
            count={ep.keys?.length}
            action={
              <Button variant="primary" size="sm" icon="add" onClick={() => setCreating(true)}>
                New key
              </Button>
            }
          />
          <div className="flex items-center justify-between gap-3 rounded-xl bg-bg-alt px-4 py-2.5 text-[13px]">
            <span>Every request needs a key</span>
            {sec ? (
              <Switch
                checked={sec.requireApiKey}
                label="Require API key"
                onChange={(v) =>
                  v
                    ? void ep.setSetting({ requireApiKey: true })
                    : setConfirm({
                        title: "Stop requiring a key?",
                        message: exposed
                          ? "A tunnel is on, so anyone with the URL could use your providers. Tunnels can't be started again until this is back on."
                          : "Anything that can reach this machine can use your providers without a key.",
                        confirmText: "Stop requiring",
                        danger: true,
                        run: () => void ep.setSetting({ requireApiKey: false }),
                      })
                }
              />
            ) : (
              <Skeleton className="h-5 w-9 rounded-full" />
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {ep.keys
              ? ep.keys.map((k) => (
                  <KeyCard
                    key={k.id}
                    k={k}
                    confirm={setConfirm}
                    onActive={(on) => void ep.setActive(k.id, on)}
                    onAccess={(a) => void ep.setAccess(k.id, a)}
                    onDelete={() => void ep.deleteKey(k.id)}
                  />
                ))
              : [0, 1].map((i) => (
                  <Panel key={i} className="space-y-3 p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-9 w-full rounded-lg" />
                    <Skeleton className="h-4 w-40" />
                  </Panel>
                ))}
          </div>
        </section>
      </div>

      {creating && <CreateKey onClose={() => setCreating(false)} onCreate={ep.createKey} />}
      {tsSetup && (
        <TailscaleSetup
          check={tsSetup}
          onClose={() => setTsSetup(null)}
          onConnect={() => {
            setTsSetup(null);
            void tn.startTailscale();
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title}
        message={confirm?.message}
        confirmText={confirm?.confirmText}
        confirmIcon={confirm?.icon}
        variant={confirm?.danger ? "danger" : "primary"}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
      />
    </div>
  );
}

function Way({
  icon,
  name,
  on,
  children,
  action,
}: {
  icon: string;
  name: string;
  on: boolean;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li>
      <Panel className="flex items-start gap-3 p-4">
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-full border",
            on
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface text-text-muted",
          )}
        >
          <Icon name={icon} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="text-[13px] font-medium">{name}</span>
            {action ?? <StatusLabel status="ok" label="Always on" />}
          </div>
          {children}
        </div>
      </Panel>
    </li>
  );
}

function UrlLine({ url }: { url: string }) {
  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1">
      {url ? (
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-muted">{url}</code>
      ) : (
        <Skeleton className="h-4 flex-1" />
      )}
      <CopyButton value={url} label="Copy URL" />
    </div>
  );
}

function TunnelWay({
  icon,
  name,
  blurb,
  t,
  locked,
  onStart,
  onStop,
}: {
  icon: string;
  name: string;
  blurb: string;
  t: TunnelState;
  locked: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const busy = t.phase === "starting";
  const on = t.phase === "on";
  return (
    <Way
      icon={icon}
      name={name}
      on={on}
      action={
        t.phase === "checking" ? (
          <Skeleton className="h-5 w-9 rounded-full" />
        ) : busy ? (
          <Button size="sm" variant="ghost" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Switch
            checked={on}
            disabled={!on && locked}
            label={on ? `Turn off ${name}` : `Turn on ${name}`}
            onChange={(v) => (v ? onStart() : onStop())}
          />
        )
      }
    >
      {on && t.url ? (
        <>
          <UrlLine url={`${t.url}/v1`} />
          {t.reachable === false && (
            <StatusLabel
              status="pending"
              label={t.everReachable ? "Not answering, reconnecting…" : "Checking the URL…"}
              className="mt-1"
            />
          )}
        </>
      ) : busy ? (
        <div className="mt-1.5 space-y-2">
          <StatusLabel status="pending" label={t.progress || "Starting…"} />
          {t.auth && (
            <Button
              size="sm"
              variant="primary"
              icon="open_in_new"
              onClick={() =>
                window.open(
                  t.auth!.url,
                  "tailscale-auth",
                  "noopener,noreferrer,width=600,height=700",
                )
              }
            >
              {t.auth.label}
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-1 text-[12px] text-text-subtle">{blurb}</p>
      )}
      {t.error && <p className="mt-1.5 text-[12px] text-danger-text">{t.error}</p>}
    </Way>
  );
}

function CreateKey({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreate(name.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New key"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="add"
            loading={busy}
            disabled={!name.trim()}
            onClick={() => void submit()}
          >
            Create key
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Where it's used, so you can tell keys apart." error={error}>
        <Input
          autoFocus
          value={name}
          placeholder="Claude Code on my laptop"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>
    </Dialog>
  );
}
