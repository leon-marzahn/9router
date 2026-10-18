export type StepKind = "tag" | "markers" | "details" | "redact" | "regex";
export interface Step {
  kind?: StepKind;
  label?: string;
  enabled?: boolean;
  regex: string;
  replacement: string;
  depth: number;
  tag?: string;
  start?: string;
  end?: string;
  title?: string;
  unclosed?: boolean;
}
export interface Pipeline {
  name: string;
  description?: string;
  rules: Step[];
  attach?: { keys: string[]; combos: string[] };
}
export interface StepStat {
  matches: number;
  replaced: number;
  preserved: number;
  removed: number;
}
export interface PipelineUsage {
  requests: number;
  charsRemoved: number;
  lastUsed: number;
}

export const kindOf = (s: Step): StepKind => s.kind ?? "regex";

export const KIND: Record<StepKind, { label: string; icon: string; blurb: string }> = {
  tag: {
    label: "Remove a tag",
    icon: "code_off",
    blurb: "Drop <tag>…</tag> blocks, e.g. a scratchpad the model re-sends every turn.",
  },
  markers: {
    label: "Remove between markers",
    icon: "data_array",
    blurb: "Drop everything from a start marker to an end marker, e.g. <!-- GFX_START -->.",
  },
  details: {
    label: "Remove a collapsible section",
    icon: "unfold_less",
    blurb: "Drop a <details> block by the words in its <summary> title.",
  },
  redact: {
    label: "Redact secrets",
    icon: "key_off",
    blurb: "Mask API keys, GitHub tokens, AWS keys and JWTs before they reach a provider.",
  },
  regex: {
    label: "Custom regex",
    icon: "regular_expression",
    blurb: "Find and replace with a regular expression. Supports $1 and $<name>.",
  },
};
export const KIND_ORDER: StepKind[] = ["tag", "markers", "details", "redact", "regex"];

export function blankStep(kind: StepKind): Step {
  const base = { regex: "", replacement: "", depth: 0 };
  if (kind === "tag") return { ...base, kind, tag: "", depth: 1 };
  if (kind === "markers") return { ...base, kind, start: "", end: "" };
  if (kind === "details") return { ...base, kind, title: "" };
  if (kind === "redact") return { ...base, kind };
  return base;
}

const keepText = (depth: number) =>
  depth > 0 ? `, keep the latest ${depth === 1 ? "one" : depth}` : "";

/** One-line plain-language summary of what a step does. */
export function describe(s: Step): string {
  const kind = kindOf(s);
  const open = s.unclosed ? " (also when unclosed)" : "";
  if (kind === "tag") return `Remove <${s.tag || "…"}> blocks${open}${keepText(s.depth)}`;
  if (kind === "markers")
    return `Remove ${s.start || "…"} … ${s.end || "…"}${open}${keepText(s.depth)}`;
  if (kind === "details") return `Remove <details> titled “${s.title || "…"}”${keepText(s.depth)}`;
  if (kind === "redact") return "Replace keys and tokens with [redacted]";
  return `Replace ${s.regex || "…"} with ${s.replacement ? `“${s.replacement}”` : "nothing"}${keepText(s.depth)}`;
}

/** Starting points offered in the overview. */
export const RECIPES: {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  pipeline: Pipeline;
}[] = [
  {
    id: "roleplay",
    title: "Roleplay summaries",
    blurb: "Strip state trackers, graphics blocks and plan sections; keep only the latest state.",
    icon: "theater_comedy",
    pipeline: {
      name: "roleplay",
      rules: [
        { ...blankStep("tag"), tag: "internal_states", unclosed: true, depth: 1 },
        {
          ...blankStep("markers"),
          start: "<!-- GFX_START -->",
          end: "<!-- GFX_END -->",
          unclosed: true,
          depth: 1,
        },
        { ...blankStep("details"), title: "Scene Plan" },
      ],
    },
  },
  {
    id: "agentic",
    title: "Long agent sessions",
    blurb: "Drop repeated reminders and scratchpads from older turns.",
    icon: "smart_toy",
    pipeline: {
      name: "agentic",
      rules: [
        { ...blankStep("tag"), tag: "system-reminder", depth: 1 },
        { ...blankStep("tag"), tag: "internal_states", depth: 1 },
      ],
    },
  },
  {
    id: "secrets",
    title: "Never leak a key",
    blurb: "Mask keys and tokens pasted into prompts or tool output.",
    icon: "shield_lock",
    pipeline: { name: "no-secrets", rules: [blankStep("redact")] },
  },
  {
    id: "blank",
    title: "Start empty",
    blurb: "One custom regex step to fill in.",
    icon: "edit_note",
    pipeline: { name: "pipeline", rules: [blankStep("regex")] },
  },
];

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
