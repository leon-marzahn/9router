"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  CodeBlock,
  CopyButton,
  Eyebrow,
  Field,
  IconButton,
  Input,
  Panel,
  ProviderLogo,
  Segmented,
  Tag,
  ConfirmDialog,
} from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { useNotificationStore } from "@/store/notificationStore";
import type { Connection } from "../../providers/model";
import { parseComboEntry, type MediaCombo, type MediaKind } from "./model";
import {
  DownloadLink,
  ErrorNote,
  RequestBlock,
  ResponseBlock,
  authHeaders,
  errorText,
  maskB64,
  now,
  useExampleEnv,
} from "./examples/shared";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStore as unknown as Notify).getState();
type Info = { name?: string; color?: string; textIcon?: string };
const PROVIDERS = AI_PROVIDERS as Record<string, Info>;

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;

const EXAMPLE_BODIES: Record<string, (name: string) => Record<string, unknown>> = {
  webSearch: (n) => ({
    model: n,
    query: "What is the latest news about AI?",
    search_type: "web",
    max_results: 5,
  }),
  webFetch: (n) => ({ model: n, url: "https://example.com", format: "markdown" }),
  image: (n) => ({ model: n, prompt: "A cute cat playing piano", n: 1, size: "1024x1024" }),
  tts: (n) => ({ model: n, input: "Hello, this is a test.", voice: "alloy" }),
};

async function call(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(data, res.status));
  return data;
}

const valueOf = (m: unknown) =>
  typeof m === "string" ? m : ((m as { value?: string } | null)?.value ?? "");

interface TestResult {
  json?: string;
  imageUrl?: string;
  audioUrl?: string;
  latencyMs: number;
}

/** A web search/fetch (or other media) combo: name, strategy, ordered providers, test, logs. */
export function MediaComboDetail({
  combo,
  kind,
  connections,
  onChanged,
  onDeleted,
}: {
  combo: MediaCombo;
  kind: MediaKind;
  connections: Connection[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const env = useExampleEnv();
  const [name, setName] = useState(combo.name);
  const [nameError, setNameError] = useState("");
  const [models, setModels] = useState<string[]>(combo.models || []);
  const [roundRobin, setRoundRobin] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState("");

  useEffect(() => {
    let off = false;
    void Promise.all([
      call("/api/settings").catch(() => null),
      call("/api/usage/logs").catch(() => null),
      call("/api/models/alias").catch(() => null),
    ]).then(([s, l, a]) => {
      if (off) return;
      setRoundRobin(s?.comboStrategies?.[combo.name]?.fallbackStrategy === "round-robin");
      setLogs(
        Array.isArray(l)
          ? (l as unknown[])
              .filter((x): x is string => typeof x === "string" && x.includes(combo.name))
              .slice(0, 50)
          : [],
      );
      setAliases(a?.aliases || {});
    });
    return () => {
      off = true;
    };
  }, [combo.name]);

  useEffect(
    () => () => {
      if (result?.audioUrl) URL.revokeObjectURL(result.audioUrl);
      if (result?.imageUrl?.startsWith("blob:")) URL.revokeObjectURL(result.imageUrl);
    },
    [result],
  );

  const save = useCallback(
    async (patch: Partial<MediaCombo>) => {
      try {
        await call(`/api/combos/${encodeURIComponent(combo.id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        onChanged();
        return true;
      } catch (e) {
        notify().error((e as Error).message || "Couldn't save the combo");
        return false;
      }
    },
    [combo.id, onChanged],
  );

  const setAndSave = async (next: string[]) => {
    const prev = models;
    setModels(next);
    if (!(await save({ models: next }))) setModels(prev);
  };

  const validate = (v: string) => {
    const err = !v.trim()
      ? "Name is required"
      : !VALID_NAME.test(v)
        ? "Only letters, numbers, -, _ and ."
        : "";
    setNameError(err);
    return !err;
  };

  const saveName = async () => {
    if (name === combo.name || !validate(name)) return;
    if (!(await save({ name }))) setName(combo.name);
  };

  const toggleRoundRobin = async (on: boolean) => {
    setRoundRobin(on);
    try {
      const s = await call("/api/settings");
      const next = { ...s?.comboStrategies };
      if (on) next[combo.name] = { fallbackStrategy: "round-robin" };
      else delete next[combo.name];
      await call("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ comboStrategies: next }),
      });
    } catch (e) {
      setRoundRobin(!on);
      notify().error(`Couldn't change the strategy: ${(e as Error).message}`);
    }
  };

  const remove = async () => {
    try {
      await call(`/api/combos/${encodeURIComponent(combo.id)}`, { method: "DELETE" });
      notify().success(`Deleted ${combo.name}`);
      onDeleted();
    } catch (e) {
      notify().error((e as Error).message || "Couldn't delete the combo");
    }
  };

  const path = kind.endpoint.path;
  const body = EXAMPLE_BODIES[kind.id]?.(combo.name);
  const curl = (key: string) =>
    `curl -X POST ${env.endpoint}${path} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '${JSON.stringify(body)}'`;

  const test = async () => {
    if (!body) return;
    setTesting(true);
    setResult(null);
    setTestError("");
    const start = now();
    try {
      const res = await fetch(`/api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(env) },
        body: JSON.stringify(body),
      });
      const latencyMs = now() - start;
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setTestError(errorText(d, res.status));
        if (d) setResult({ json: JSON.stringify(d, null, 2), latencyMs });
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      if (ctype.startsWith("image/")) {
        setResult({ imageUrl: URL.createObjectURL(await res.blob()), latencyMs });
        return;
      }
      if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        setResult({ audioUrl: URL.createObjectURL(await res.blob()), latencyMs });
        return;
      }
      const data = await res.json();
      const first = data?.data?.[0];
      setResult({
        json: JSON.stringify(maskB64(data), null, 2),
        imageUrl: first?.b64_json ? `data:image/png;base64,${first.b64_json}` : first?.url || "",
        latencyMs,
      });
    } catch (e) {
      setTestError((e as Error).message || "Network error");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-2xl">{combo.name}</h1>
          <p className="mt-1 text-[13px] text-text-muted">
            {kind.label} combo. Send <code className="font-mono">{combo.name}</code> as the model.
          </p>
        </div>
        <span className="flex items-center gap-1">
          <CopyButton value={combo.name} label="Copy model name" />
          <IconButton icon="delete" label="Delete combo" onClick={() => setConfirmDelete(true)} />
        </span>
      </header>

      <Panel className="divide-y divide-border px-4">
        <div className="py-4">
          <Field label="Name" error={nameError} hint="Letters, numbers, -, _ and .">
            <Input
              mono
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                validate(e.target.value);
              }}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 sm:max-w-sm">
            <div className="text-[13px] font-medium">How it picks</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
              {roundRobin
                ? "Takes turns between the providers across requests."
                : "Top to bottom: the next provider is only tried when the one before fails."}
            </div>
          </div>
          <Segmented<"fallback" | "round-robin">
            className="shrink-0"
            value={roundRobin ? "round-robin" : "fallback"}
            onChange={(v) => void toggleRoundRobin(v === "round-robin")}
            options={[
              { value: "fallback", label: "In order" },
              { value: "round-robin", label: "Take turns" },
            ]}
          />
        </div>
      </Panel>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-medium">
            Providers <span className="text-text-subtle">{models.length}</span>
          </h2>
          <Button icon="add" onClick={() => setPicker(true)}>
            Add provider
          </Button>
        </div>
        {models.length === 0 ? (
          <Panel className="p-6 text-center text-[13px] text-text-muted">
            No providers yet. Add the ones this combo should use.
          </Panel>
        ) : (
          <ol className="space-y-2">
            {models.map((entry, i) => {
              const { providerId, model } = parseComboEntry(entry);
              const p = PROVIDERS[providerId];
              const conns = connections.filter((c) => c.provider === providerId);
              const ready = conns.filter((c) => c.isActive !== false).length;
              return (
                <li key={`${entry}-${i}`}>
                  <Panel className="flex items-center gap-3 p-3">
                    <span className="w-4 text-center text-[11px] tabular-nums text-text-subtle">
                      {i + 1}
                    </span>
                    <ProviderLogo
                      providerId={providerId}
                      name={p?.name || providerId}
                      color={p?.color}
                      fallbackText={p?.textIcon}
                      size={22}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px]">{p?.name || providerId}</div>
                      <div className="truncate text-[11px] text-text-muted">
                        {model ? <span className="font-mono">{model}</span> : null}
                        {model ? " · " : ""}
                        {ready > 0
                          ? `${ready} account${ready === 1 ? "" : "s"}`
                          : conns.length > 0
                            ? "paused"
                            : "no account"}
                      </div>
                    </div>
                    <IconButton
                      icon="arrow_upward"
                      label="Move up"
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...models];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        void setAndSave(next);
                      }}
                    />
                    <IconButton
                      icon="arrow_downward"
                      label="Move down"
                      disabled={i === models.length - 1}
                      onClick={() => {
                        const next = [...models];
                        [next[i + 1], next[i]] = [next[i], next[i + 1]];
                        void setAndSave(next);
                      }}
                    />
                    <IconButton
                      icon="close"
                      label={`Remove ${p?.name || providerId}`}
                      onClick={() => void setAndSave(models.filter((_, j) => j !== i))}
                    />
                  </Panel>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {body && (
        <section>
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Eyebrow>Try it</Eyebrow>
            <Tag mono>POST</Tag>
            <span className="min-w-0 truncate font-mono text-[11px] text-text-subtle">{path}</span>
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-surface p-3 sm:p-4">
            <RequestBlock
              env={env}
              curl={curl}
              onRun={test}
              running={testing}
              disabled={models.length === 0}
              runLabel="Test combo"
              runningLabel="Testing…"
            />
            <ErrorNote>{testError}</ErrorNote>
            {result && (
              <ResponseBlock
                latencyMs={result.latencyMs}
                text={result.json}
                action={
                  result.imageUrl ? (
                    <DownloadLink href={result.imageUrl} filename="image.png" />
                  ) : result.audioUrl ? (
                    <DownloadLink href={result.audioUrl} filename="speech.mp3" />
                  ) : null
                }
              >
                {result.imageUrl && (
                  // oxlint-disable-next-line nextjs/no-img-element -- generated image
                  <img
                    src={result.imageUrl}
                    alt="Generated"
                    className="max-w-full rounded-lg border border-border"
                  />
                )}
                {result.audioUrl && <audio controls src={result.audioUrl} className="w-full" />}
              </ResponseBlock>
            )}
          </div>
        </section>
      )}

      <section>
        <Eyebrow className="mb-2">Recent requests</Eyebrow>
        {logs === null ? (
          <p className="text-xs text-text-subtle">Loading…</p>
        ) : logs.length === 0 ? (
          <Panel className="p-6 text-center text-[13px] text-text-muted">
            No requests through this combo yet.
          </Panel>
        ) : (
          <CodeBlock text={logs.join("\n")} wrap preClassName="max-h-80 text-[11px]" />
        )}
      </section>

      {picker && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicker(false)}
          onSelect={(m) => {
            const v = valueOf(m);
            if (v && !models.includes(v)) void setAndSave([...models, v]);
          }}
          onDeselect={(m) => {
            const v = valueOf(m);
            if (v && models.includes(v)) void setAndSave(models.filter((x) => x !== v));
          }}
          activeProviders={connections.filter((c) => c.isActive !== false)}
          modelAliases={aliases}
          title={`Add ${kind.label} provider`}
          kindFilter={kind.id}
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${combo.name}?`}
        message="Apps sending this combo as the model get an error until you point them somewhere else."
        confirmText="Delete"
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
      />
    </div>
  );
}
