// Translator: a debug tool that replays one request through the same steps the
// gateway takes (client format → OpenAI → provider format → provider → back),
// so you can see where a translation goes wrong. Steps on the left, the
// selected step's content on the right. Only exists with ENABLE_TRANSLATOR=true.
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button, EmptyState, Eyebrow, Icon, ListRow, Panel, Tag } from "@/ui";
import { cn } from "@/ui/cn";
import { useTheme as useThemeJs } from "@/shared/hooks/useTheme";
import { Note } from "@/ui";
import { notify } from "../profile/settings/useSettings";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const useTheme = useThemeJs as unknown as () => { isDark: boolean };

type StepId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Step = { id: StepId; label: string; file: string; lang: "json" | "plaintext"; desc: string };
type Meta = { provider: string; model: string; sourceFormat: string; targetFormat: string };

// Same order and file names as the gateway's request logger (logs/translator/).
const STEPS: Step[] = [
  {
    id: 1,
    label: "Request from your app",
    file: "1_req_client.json",
    lang: "json",
    desc: "The request exactly as the client sent it. Paste one here, or load the last one the gateway logged.",
  },
  {
    id: 2,
    label: "Request body",
    file: "2_req_source.json",
    lang: "json",
    desc: "Just the body of step 1, saved when you convert it.",
  },
  {
    id: 3,
    label: "In OpenAI format",
    file: "3_req_openai.json",
    lang: "json",
    desc: "The request converted to OpenAI's format. Every translation passes through this shape.",
  },
  {
    id: 4,
    label: "Request to the provider",
    file: "4_req_target.json",
    lang: "json",
    desc: "The request in the provider's own format, with the address it goes to. Keys and tokens are hidden.",
  },
  {
    id: 5,
    label: "Provider's reply",
    file: "5_res_provider.txt",
    lang: "plaintext",
    desc: "What the provider streamed back, unchanged.",
  },
  {
    id: 6,
    label: "Reply in OpenAI format",
    file: "6_res_openai.txt",
    lang: "plaintext",
    desc: "The provider's reply converted to OpenAI's format. Load it from the logs.",
  },
  {
    id: 7,
    label: "Reply to your app",
    file: "7_res_client.txt",
    lang: "plaintext",
    desc: "The reply in the format the client expects. Load it from the logs.",
  },
];

const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  automaticLayout: true,
};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false)
    throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function parse(raw: string | undefined, what: string) {
  try {
    return JSON.parse(raw ?? "");
  } catch {
    throw new Error(`${what} isn't valid JSON.`);
  }
}

export function Translator() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setEnabled(!!d?.enableTranslator))
      .catch(() => setEnabled(false));
  }, []);

  if (enabled === null) return <p className="text-sm text-text-muted">Loading…</p>;
  if (!enabled)
    return (
      <EmptyState icon="translate" className="mx-auto max-w-3xl">
        The translator debug tool is turned off. Start the server with{" "}
        <code className="font-mono text-xs text-text">ENABLE_TRANSLATOR=true</code> to use it.
      </EmptyState>
    );
  return <Workbench />;
}

function Workbench() {
  const { isDark } = useTheme();
  const [contents, setContents] = useState<Partial<Record<StepId, string>>>({});
  const [selected, setSelected] = useState<StepId>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);

  const setContent = (id: StepId, v: string) => setContents((c) => ({ ...c, [id]: v }));
  const step = STEPS.find((s) => s.id === selected)!;
  const content = contents[selected] ?? "";

  // Saving the intermediate files is a convenience; a failure shouldn't block the run.
  const save = (file: string, text: string) =>
    postJson("/api/translator/save", { file, content: text }).catch((e) =>
      notify().error(`Couldn't save ${file}: ${e.message}`),
    );

  const detect = async (raw: string) => {
    try {
      const body = JSON.parse(raw);
      const data = await postJson("/api/translator/translate", { step: 1, body });
      setMeta(data.result);
    } catch {
      setMeta(null);
    }
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const load = (id: StepId) =>
    run(`load-${id}`, async () => {
      const s = STEPS.find((x) => x.id === id)!;
      const res = await fetch(`/api/translator/load?file=${encodeURIComponent(s.file)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success)
        throw new Error(
          res.status === 404 ? `Nothing logged yet for ${s.file}.` : data.error || "Couldn't load",
        );
      setContent(id, data.content);
      if (id === 1) await detect(data.content);
    });

  const toOpenAI = () =>
    run("toOpenAI", async () => {
      const raw = contents[1] ?? "";
      const body = parse(raw, "Step 1");
      void save("1_req_client.json", raw);
      void save(
        "2_req_source.json",
        JSON.stringify(
          { timestamp: new Date().toISOString(), headers: {}, body: body.body || body },
          null,
          2,
        ),
      );
      const data = await postJson("/api/translator/translate", { step: 2, body });
      setContent(2, JSON.stringify(body.body || body, null, 2));
      setContent(3, JSON.stringify(data.result.body, null, 2));
      setSelected(3);
    });

  const toTarget = () =>
    run("toTarget", async () => {
      const raw = contents[3] ?? "";
      const body = parse(raw, "Step 3");
      if (!meta) throw new Error("Couldn't tell which provider step 1 is for. Check its model.");
      void save("3_req_openai.json", raw);
      const data = await postJson("/api/translator/translate", {
        step: 3,
        body: { ...body, provider: meta.provider, model: meta.model },
      });
      setContent(
        4,
        JSON.stringify({ ...data.result, provider: meta.provider, model: meta.model }, null, 2),
      );
      setSelected(4);
    });

  const send = () =>
    run("send", async () => {
      const raw = contents[4] ?? "";
      const step4 = parse(raw, "Step 4");
      const provider = step4.provider || meta?.provider;
      const model = step4.model || meta?.model;
      if (!provider || !model)
        throw new Error("Step 4 needs a provider and model. Run steps 1 and 3 first.");
      void save("4_req_target.json", raw);
      const res = await fetch("/api/translator/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, body: step4.body || step4 }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Send failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setContent(5, full);
      }
      setContent(5, full);
      setSelected(5);
      void save("5_res_provider.txt", full);
    });

  const format = () => {
    try {
      setContent(selected, JSON.stringify(JSON.parse(content), null, 2));
    } catch {
      notify().error("This step isn't JSON, so there's nothing to format.");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      notify().success("Copied");
    } catch {
      notify().error("Couldn't copy to the clipboard");
    }
  };

  const action =
    selected === 1
      ? { key: "toOpenAI", label: "Convert to OpenAI format", icon: "arrow_forward", fn: toOpenAI }
      : selected === 3
        ? {
            key: "toTarget",
            label: "Convert for the provider",
            icon: "arrow_forward",
            fn: toTarget,
          }
        : selected === 4
          ? { key: "send", label: "Send to provider", icon: "send", fn: send }
          : null;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Translator</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-muted">
          Replay one request through each step the gateway takes, to see where a translation goes
          wrong. Steps 1–5 can be run from here; every step can be loaded from the last logged
          request.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Panel className="p-1.5">
            {STEPS.map((s) => (
              <ListRow
                key={s.id}
                active={s.id === selected}
                onClick={() => setSelected(s.id)}
                leading={
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px]",
                      contents[s.id]
                        ? "bg-success/12 text-success-text"
                        : "bg-surface-2 text-text-muted",
                    )}
                  >
                    {contents[s.id] ? <Icon name="check" size={14} /> : s.id}
                  </span>
                }
                title={s.label}
                subtitle={<span className="font-mono">{s.file}</span>}
              />
            ))}
          </Panel>
          <Panel className="space-y-2 p-4">
            <Eyebrow>Detected from step 1</Eyebrow>
            {meta ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-text-muted">Format</dt>
                <dd className="flex flex-wrap items-center gap-1">
                  <Tag mono>{meta.sourceFormat}</Tag>
                  <Icon name="arrow_forward" size={12} className="text-text-subtle" />
                  <Tag mono>{meta.targetFormat}</Tag>
                </dd>
                <dt className="text-text-muted">Provider</dt>
                <dd className="truncate font-mono">{meta.provider}</dd>
                <dt className="text-text-muted">Model</dt>
                <dd className="truncate font-mono">{meta.model}</dd>
              </dl>
            ) : (
              <p className="text-xs text-text-muted">
                Paste or load a request in step 1 to see which provider it goes to.
              </p>
            )}
          </Panel>
        </aside>

        <section className="min-w-0 space-y-3">
          <div>
            <h2 className="font-display text-xl">
              {step.id}. {step.label}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">{step.desc}</p>
          </div>
          {selected === 4 && (
            <Note tone="warning">
              Sending makes a real request with your provider account and counts against its quota.
            </Note>
          )}
          <Panel className="overflow-hidden">
            <Editor
              height="min(60vh, 520px)"
              language={step.lang}
              value={content}
              onChange={(v) => {
                setContent(selected, v ?? "");
                if (selected === 1) void detect(v ?? "");
              }}
              theme={isDark ? "vs-dark" : "light"}
              options={EDITOR_OPTIONS}
            />
          </Panel>
          {error && <Note tone="danger">{error}</Note>}
          <div className="flex flex-wrap items-center gap-2">
            {action && (
              <Button
                variant="primary"
                icon={action.icon}
                loading={busy === action.key}
                disabled={!content || (busy != null && busy !== action.key)}
                onClick={action.fn}
              >
                {action.label}
              </Button>
            )}
            <Button
              icon="folder_open"
              loading={busy === `load-${selected}`}
              onClick={() => load(selected)}
            >
              Load last logged
            </Button>
            <Button icon="data_object" onClick={format} disabled={!content}>
              Format
            </Button>
            <Button icon="content_copy" onClick={copy} disabled={!content}>
              Copy
            </Button>
            {content && (
              <span className="ml-auto text-[11px] tabular-nums text-text-subtle">
                {content.length.toLocaleString()} characters
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
