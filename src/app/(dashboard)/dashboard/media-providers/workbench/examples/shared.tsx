"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Button, Eyebrow, Icon, Panel, Tag, cn, inputClass } from "@/ui";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const noSubscribe = () => () => {};

/** Wall clock for request latency (kept out of render). */
export const now = () => Date.now();

export type KeyState = "loading" | "ok" | "none" | "error";

/**
 * Where example requests go and with which gateway key. The key stays in
 * memory: it is shown masked, only the copied curl carries it in full, and
 * test calls go to this origin (never the tunnel) so it never leaves the box.
 */
export function useExampleEnv() {
  const [apiKey, setApiKey] = useState("");
  const [keyState, setKeyState] = useState<KeyState>("loading");
  const origin = useSyncExternalStore(
    noSubscribe,
    () => window.location.origin,
    () => "",
  );
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);

  useEffect(() => {
    let off = false;
    fetch("/api/keys", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { keys?: { key: string; isActive?: boolean }[] }) => {
        if (off) return;
        const key = (d.keys || []).find((k) => k.isActive !== false)?.key || "";
        setApiKey(key);
        setKeyState(key ? "ok" : "none");
      })
      .catch(() => !off && setKeyState("error"));
    fetch("/api/tunnel/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { publicUrl?: string }) => !off && d.publicUrl && setTunnelUrl(d.publicUrl))
      .catch(() => {
        /* no tunnel: the toggle just stays hidden */
      });
    return () => {
      off = true;
    };
  }, []);

  return {
    apiKey,
    keyState,
    tunnelUrl,
    useTunnel: useTunnel && !!tunnelUrl,
    setUseTunnel,
    /** Base URL shown in the example (tunnel when toggled). */
    endpoint: useTunnel && tunnelUrl ? tunnelUrl : origin,
  };
}
export type ExampleEnv = ReturnType<typeof useExampleEnv>;

export const maskKey = (k: string) =>
  k ? `${k.slice(0, 8)}${"•".repeat(Math.min(12, Math.max(0, k.length - 8)))}` : "";

/** Authorization header for test calls (the gateway may not require one). */
export const authHeaders = (env: ExampleEnv): Record<string, string> =>
  env.apiKey ? { Authorization: `Bearer ${env.apiKey}` } : {};

/** Best human message from an error body (string, {error: string}, {error: {message}}). */
export function errorText(data: unknown, status: number): string {
  if (typeof data === "string" && data.trim()) return data.slice(0, 500);
  const d = data as { error?: unknown; message?: unknown } | null;
  const e = d?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string")
    return (e as { message: string }).message;
  if (typeof d?.message === "string") return d.message;
  return `Request failed (HTTP ${status})`;
}

/** Replace large base64 blobs so the JSON view stays readable. */
export function maskB64(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskB64);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      (k === "b64_json" || k === "audio") && typeof v === "string" && v.length > 100
        ? `<${v.length} chars base64>`
        : maskB64(v),
    ]),
  );
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(inputClass, "pr-8", className)} {...rest} />;
}

/** Label + control; stacked on mobile, side by side from sm. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-3">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const readout =
  "flex h-9 min-w-0 items-center truncate rounded-lg bg-surface-2 px-3 font-mono text-xs text-text";

export function EndpointRow({ env, path }: { env: ExampleEnv; path: string }) {
  return (
    <Row label="Endpoint">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(readout, "flex-1")} title={`${env.endpoint}${path}`}>
          <span className="truncate">
            {env.endpoint}
            {path}
          </span>
        </span>
        {env.tunnelUrl && (
          <Button
            variant={env.useTunnel ? "inverse" : "secondary"}
            icon="wifi_tethering"
            aria-pressed={env.useTunnel}
            onClick={() => env.setUseTunnel((v) => !v)}
            title="Show the public tunnel URL in the example (test runs stay local)"
          >
            Tunnel
          </Button>
        )}
      </div>
    </Row>
  );
}

export function KeyRow({ env, fallback }: { env: ExampleEnv; fallback?: ReactNode }) {
  return (
    <Row label="API key">
      <span className={readout}>
        {env.keyState === "ok" ? (
          maskKey(env.apiKey)
        ) : env.keyState === "loading" ? (
          <span className="text-text-subtle">Loading…</span>
        ) : env.keyState === "error" ? (
          <span className="font-sans text-danger-text">Couldn’t load your API keys</span>
        ) : (
          <span className="font-sans text-text-muted">
            {fallback ?? "No gateway key — sent without one"}
          </span>
        )}
      </span>
    </Row>
  );
}

/** The whole "Try it" surface: header, form rows, request, response. */
export function ExamplePanel({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <Panel className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Try it</h2>
        <Tag mono>{method}</Tag>
        <span className="min-w-0 truncate font-mono text-xs text-text-muted">{path}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </Panel>
  );
}

/**
 * curl preview + Run. `curl(key)` builds the command; the page shows it with a
 * masked key and the full key only goes to the clipboard.
 */
export function RequestBlock({
  env,
  curl,
  onRun,
  running,
  disabled,
  runLabel = "Run",
  runningLabel = "Running…",
}: {
  env: ExampleEnv;
  curl: (key: string) => string;
  onRun: () => void;
  running: boolean;
  disabled?: boolean;
  runLabel?: string;
  runningLabel?: string;
}) {
  const { copied, copy } = useCopyToClipboard();
  const keyFor = (full: boolean) =>
    env.apiKey ? (full ? env.apiKey : maskKey(env.apiKey)) : "YOUR_KEY";
  return (
    <div className="pt-1">
      <div className="mb-1.5 flex items-center gap-2">
        <Eyebrow>Request</Eyebrow>
        <Button
          variant="ghost"
          icon={copied ? "check" : "content_copy"}
          className="ml-auto"
          onClick={() => copy(curl(keyFor(true)))}
          title="Copies the command with your full key"
        >
          {copied ? "Copied" : "Copy curl"}
        </Button>
        <Button
          variant="primary"
          icon="play_arrow"
          loading={running}
          disabled={running || disabled}
          onClick={onRun}
        >
          {running ? runningLabel : runLabel}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-text">
        {curl(keyFor(false))}
      </pre>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger-text"
    >
      <Icon name="error" size={16} className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function ResponseBlock({
  text,
  copyText,
  placeholder,
  latencyMs,
  action,
  children,
}: {
  text?: string;
  /** What Copy puts on the clipboard when it differs from the shown text. */
  copyText?: string;
  placeholder?: string;
  latencyMs?: number | null;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div>
      <div className="mb-1.5 flex min-h-8 items-center gap-2">
        <Eyebrow>Response</Eyebrow>
        {latencyMs != null && (
          <span className="text-[11px] tabular-nums text-text-muted">{latencyMs} ms</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {action}
          {text && (
            <Button
              variant="ghost"
              icon={copied ? "check" : "content_copy"}
              onClick={() => copy(copyText ?? text)}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </div>
      {children}
      {(text || placeholder) && (
        <pre
          className={cn(
            "max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed",
            text ? "text-text" : "text-text-subtle",
            children ? "mt-2" : "",
          )}
        >
          {text || placeholder}
        </pre>
      )}
    </div>
  );
}

export function DownloadLink({ href, filename }: { href: string; filename: string }) {
  return (
    <a
      href={href}
      download={filename}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
    >
      Download <Icon name="download" size={16} />
    </a>
  );
}
