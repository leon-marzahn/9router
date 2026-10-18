// PROTOTYPE: mock pipelines, step kinds and a sample request. Nothing here is saved.
"use client";

import { transformRequest } from "@/lib/request-pipelines/engine.js";

export type StepKind = "strip-tag" | "redact" | "replace" | "drop-old";
export type Step = {
  id: string;
  kind: StepKind;
  enabled: boolean;
  /** strip-tag */ tag?: string;
  /** keep the latest N matches (engine "depth") */ keep?: number;
  /** replace / redact */ regex?: string;
  replacement?: string;
  hits24h: number;
};
export type Attach = { type: "header" | "key" | "combo"; value: string };
export type Pipeline = {
  name: string;
  description: string;
  steps: Step[];
  attach: Attach[];
  requests24h: number;
  tokensSaved24h: number;
  lastUsed: string;
};

export const KIND: Record<StepKind, { label: string; icon: string; blurb: string; isNew?: boolean }> = {
  "strip-tag": { label: "Strip a tag", icon: "code_off", blurb: "Remove <tag>…</tag> blocks, optionally keeping the latest few." },
  redact: { label: "Redact secrets", icon: "key_off", blurb: "Mask API keys, tokens and emails before they leave this machine.", isNew: true },
  replace: { label: "Find & replace", icon: "find_replace", blurb: "Regex replace with $1 capture references. The power tool." },
  "drop-old": { label: "Trim old tool output", icon: "content_cut", blurb: "Shorten tool results older than the last N turns.", isNew: true },
};

/** Every friendly step compiles down to today's engine rule (regex, replacement, depth). */
export function toRule(s: Step) {
  if (s.kind === "strip-tag") {
    const t = (s.tag || "tag").replace(/[^\w-]/g, "");
    return { regex: `<${t}>[\\s\\S]*?</${t}>`, replacement: "", depth: s.keep ?? 0 };
  }
  if (s.kind === "redact")
    return {
      regex: "/(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+)/",
      replacement: "[redacted]",
      depth: 0,
    };
  if (s.kind === "drop-old")
    return { regex: "/^([\\s\\S]{200})[\\s\\S]{200,}$/", replacement: "$1 …[trimmed]", depth: s.keep ?? 2 };
  return { regex: s.regex || "x^", replacement: s.replacement ?? "", depth: s.keep ?? 0 };
}

export function describe(s: Step) {
  if (s.kind === "strip-tag")
    return `Remove <${s.tag}> blocks${s.keep ? `, keep the latest ${s.keep}` : ""}`;
  if (s.kind === "redact") return "Mask sk-…, AKIA…, ghp_… and JWTs";
  if (s.kind === "drop-old") return `Trim tool output older than the last ${s.keep ?? 2}`;
  return `Replace /${s.regex}/ with ${s.replacement ? `“${s.replacement}”` : "nothing"}`;
}

let n = 0;
const step = (p: Omit<Step, "id" | "enabled" | "hits24h"> & Partial<Step>): Step => ({
  id: `s${n++}`,
  enabled: true,
  hits24h: 0,
  ...p,
});

export const PIPELINES: Pipeline[] = [
  {
    name: "agentic",
    description: "Keeps long agent sessions small: old scratchpad state goes, the latest stays.",
    steps: [
      step({ kind: "strip-tag", tag: "internal_states", keep: 1, hits24h: 1840 }),
      step({ kind: "strip-tag", tag: "system-reminder", keep: 1, hits24h: 922 }),
      step({ kind: "drop-old", keep: 2, hits24h: 311 }),
    ],
    attach: [
      { type: "header", value: "agentic" },
      { type: "combo", value: "coding-fast" },
    ],
    requests24h: 2140,
    tokensSaved24h: 1_920_000,
    lastUsed: "12s ago",
  },
  {
    name: "no-secrets",
    description: "Masks credentials pasted into prompts before they reach any provider.",
    steps: [step({ kind: "redact", hits24h: 7 })],
    attach: [
      { type: "key", value: "Work laptop" },
      { type: "key", value: "CI runner" },
    ],
    requests24h: 860,
    tokensSaved24h: 0,
    lastUsed: "3m ago",
  },
  {
    name: "house-style",
    description: "Rewrites a legacy system prompt phrase.",
    steps: [
      step({ kind: "replace", regex: "You are ChatGPT", replacement: "You are a helpful assistant", hits24h: 0 }),
    ],
    attach: [{ type: "header", value: "house-style" }],
    requests24h: 0,
    tokensSaved24h: 0,
    lastUsed: "6 days ago",
  },
];

export const RECIPES: { title: string; blurb: string; icon: string; steps: StepKind[] }[] = [
  { title: "Long agent sessions", blurb: "Strip stale scratchpad tags, trim old tool output.", icon: "smart_toy", steps: ["strip-tag", "drop-old"] },
  { title: "Never leak a key", blurb: "Mask API keys, tokens and JWTs in every message.", icon: "shield_lock", steps: ["redact"] },
  { title: "Hide reasoning from history", blurb: "Drop <thinking> blocks from earlier turns.", icon: "visibility_off", steps: ["strip-tag"] },
  { title: "Start from scratch", blurb: "One find & replace rule.", icon: "edit_note", steps: ["replace"] },
];

export const SAMPLE = {
  model: "coding-fast",
  messages: [
    { role: "system", content: "You are ChatGPT, a coding agent. <system-reminder>Plan mode is off.</system-reminder>" },
    { role: "user", content: "Fix the flaky test. <internal_states>step=1 files=[]</internal_states>" },
    { role: "assistant", content: "Looking at tests/unit/queue.test.js now." },
    { role: "user", content: "Here's my key if needed: sk-demo1234567890abcdefXYZ <internal_states>step=2 files=[queue.test.js]</internal_states>" },
    { role: "user", content: "Continue. <system-reminder>Plan mode is off.</system-reminder> <internal_states>step=3 files=[queue.test.js, queue.js]</internal_states>" },
  ],
};

export type Change = { path: string; before: string; after: string };

export function run(p: Pipeline, body: unknown = SAMPLE) {
  const rules = p.steps.filter((s) => s.enabled).map(toRule);
  try {
    const out = transformRequest(body, rules) as { body: typeof SAMPLE; stats: { matches: number; replaced: number; preserved: number }[] };
    const changes: Change[] = [];
    (body as typeof SAMPLE).messages.forEach((m, i) => {
      const after = out.body.messages[i].content;
      if (after !== m.content) changes.push({ path: `messages[${i}] · ${m.role}`, before: m.content, after });
    });
    const saved = JSON.stringify(body).length - JSON.stringify(out.body).length;
    return { ...out, changes, saved, error: null as string | null };
  } catch (e) {
    return { body, stats: [], changes: [], saved: 0, error: (e as Error).message };
  }
}

export const fmt = (x: number) =>
  x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x);
