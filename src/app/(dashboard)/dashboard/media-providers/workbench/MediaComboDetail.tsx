"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  EmptyState,
  Eyebrow,
  Field,
  Icon,
  IconButton,
  Input,
  Panel,
  ProviderLogo,
  Switch,
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

const PickerModal = ModelSelectModal as unknown as (p: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (m: unknown) => void;
  onDeselect: (m: unknown) => void;
  activeProviders: Connection[];
  modelAliases: Record<string, string>;
  title: string;
  kindFilter: string;
  addedModelValues: string[];
  closeOnSelect: boolean;
}) => ReactNode;

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
    if (!confirm(`Delete combo "${combo.name}"?`)) return;
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
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface text-accent shadow-soft ring-1 ring-border">
          <Icon name="layers" size={28} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-2xl tracking-tight">{combo.name}</h1>
          <p className="mt-1 text-xs text-text-muted">
            {kind.label} combo · {models.length} provider{models.length === 1 ? "" : "s"} ·{" "}
            {roundRobin ? "round-robin" : "fallback in order"}
          </p>
        </div>
        <Button variant="danger" icon="delete" onClick={remove}>
          Delete
        </Button>
      </div>

      <div className="mt-8 space-y-6">
        <Panel className="space-y-4 p-4 sm:p-5">
          <Field
            label="Name"
            error={nameError}
            hint="Clients request this name as the model. Letters, numbers, -, _ and ."
          >
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
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Round robin</div>
              <div className="text-xs text-text-muted">
                Rotate providers across requests instead of strict fallback order.
              </div>
            </div>
            <Switch checked={roundRobin} onChange={toggleRoundRobin} label="Round robin" />
          </div>
        </Panel>

        <Panel className="p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Providers</h2>
              <p className="text-xs text-text-muted">
                Tried top-down, or rotated when round robin is on.
              </p>
            </div>
            <Button icon="add" onClick={() => setPicker(true)}>
              Add provider
            </Button>
          </div>
          {models.length === 0 ? (
            <EmptyState icon="layers">Add a provider so this combo can route requests.</EmptyState>
          ) : (
            <ol className="space-y-1.5">
              {models.map((entry, i) => {
                const { providerId, model } = parseComboEntry(entry);
                const p = PROVIDERS[providerId];
                return (
                  <li
                    key={`${entry}-${i}`}
                    className="flex items-center gap-3 rounded-lg bg-surface-2 px-2.5 py-2"
                  >
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
                      {model && (
                        <div className="truncate font-mono text-[11px] text-text-muted">
                          {model}
                        </div>
                      )}
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
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        {body && (
          <Panel className="space-y-3 p-4 sm:p-5">
            <h2 className="text-base font-semibold">Try it</h2>
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
          </Panel>
        )}

        <Panel className="p-4 sm:p-5">
          <Eyebrow className="mb-2">Recent requests</Eyebrow>
          {logs === null ? (
            <p className="text-xs text-text-subtle">Loading…</p>
          ) : logs.length === 0 ? (
            <p className="text-xs text-text-muted">No requests through this combo yet.</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-[11px]">
              {logs.join("\n")}
            </pre>
          )}
        </Panel>
      </div>

      {picker && (
        <PickerModal
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
    </div>
  );
}
