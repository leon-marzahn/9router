"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Icon, Segmented } from "@/ui";
import type { Pipeline, StepStat } from "./steps";
import { json } from "./usePipelines";

type Mode = "text" | "json";
const SPLIT = /^\s*---\s*$/m;
const SAMPLE_TEXT = [
  "<!-- GFX_START -->[old art]<!-- GFX_END -->\nEarlier turn. <internal_states>mood: calm</internal_states>",
  "---",
  "<!-- GFX_START -->[scene art]<!-- GFX_END -->\n<details><summary>🎬 Scene Plan</summary>beats…</details>\nThe story continues.",
  "---",
  "Latest turn. <internal_states>mood: tense</internal_states>",
].join("\n");
// Kept outside the component so the sample survives switching pipelines.
const memory: { mode: Mode; text: string; json: string } = {
  mode: "text",
  text: SAMPLE_TEXT,
  json: JSON.stringify(
    { messages: [{ role: "user", content: "Hello <internal_states>x</internal_states>" }] },
    null,
    2,
  ),
};

type Change = { path: string; before: string; after: string };

function textFields(value: unknown, path: string, out: Map<string, string>) {
  if (typeof value === "string") out.set(path, value);
  else if (Array.isArray(value)) value.forEach((v, i) => textFields(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) textFields(v, path ? `${path}.${k}` : k, out);
}

function diff(before: unknown, after: unknown): Change[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  textFields(before, "", a);
  textFields(after, "", b);
  return [...a]
    .filter(([k, v]) => b.get(k) !== v)
    .map(([path, v]) => ({ path, before: v, after: b.get(path) ?? "" }));
}

/** Runs the unsaved pipeline on a sample through the server preview (same worker and limits as real requests). */
export function Preview({
  pipeline,
  onStats,
}: {
  pipeline: Pipeline;
  onStats: (s: (StepStat | null)[]) => void;
}) {
  const [mode, setMode] = useState<Mode>(memory.mode);
  const [text, setText] = useState(memory[memory.mode]);
  const [result, setResult] = useState<{ changes: Change[]; removed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(pipeline);

  useEffect(() => {
    memory.mode = mode;
    memory[mode] = text;
    const timer = setTimeout(async () => {
      let body: unknown;
      try {
        body =
          mode === "json"
            ? JSON.parse(text)
            : {
                messages: text
                  .split(SPLIT)
                  .map((content) => ({ role: "user", content: content.trim() })),
              };
      } catch {
        setError("Sample is not valid JSON");
        return;
      }
      try {
        const data = await json("/api/settings/request-pipelines/preview", {
          method: "POST",
          body: JSON.stringify({ pipeline: JSON.parse(key), body }),
        });
        const stats = data.stats as (StepStat | null)[];
        onStats(stats);
        setResult({
          changes: diff(body, data.body),
          removed: stats.reduce((n, s) => n + (s?.removed ?? 0), 0),
        });
        setError(null);
      } catch (e) {
        onStats([]);
        setResult(null);
        setError((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [key, mode, text, onStats]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>Try it · unsaved steps on a sample</Eyebrow>
        <Segmented<Mode>
          size="sm"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setText(memory[m]);
          }}
          options={[
            { value: "text", label: "Text" },
            { value: "json", label: "Request JSON" },
          ]}
        />
      </div>
      <textarea
        rows={mode === "text" ? 6 : 10}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Sample"
        className="w-full rounded-xl border border-border-strong bg-surface px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent dark:border-border"
      />
      <p className="text-[11px] text-text-subtle">
        {mode === "text"
          ? "Each part between lines of --- is one message, oldest first. Nothing here is saved or sent to a provider."
          : "A full chat request body (OpenAI, Claude, Responses or Gemini shape). Nothing here is saved or sent to a provider."}
      </p>
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger-text">
          <Icon name="error" size={14} className="mt-px shrink-0" />
          {error}
        </p>
      ) : result && !result.changes.length ? (
        <p className="text-[13px] text-text-muted">Nothing in this sample matches.</p>
      ) : result ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-[12px] text-text-muted">
            {result.changes.length} field{result.changes.length === 1 ? "" : "s"} changed ·{" "}
            {result.removed} characters removed
          </p>
          {result.changes.map((c) => (
            <div key={c.path} className="overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border bg-surface-2 px-3 py-1.5 font-mono text-[11px] text-text-muted">
                {c.path}
              </div>
              <div className="grid font-mono text-[12px] leading-relaxed md:grid-cols-2">
                <div className="whitespace-pre-wrap break-words bg-danger/5 px-3 py-2 text-text-muted">
                  {c.before}
                </div>
                <div className="whitespace-pre-wrap break-words bg-success/5 px-3 py-2">
                  {c.after || <span className="text-text-subtle">(empty)</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
