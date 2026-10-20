export const PIPELINE_HEADER = "x-regent-pipeline";
/** Pre-rename name, still honoured. */
export const LEGACY_PIPELINE_HEADER = "x-9router-pipeline";

export const STEP_KINDS = ["tag", "markers", "details", "redact", "regex"];
/** Upper bound for one removed block, so an unclosed start never scans an entire huge message. */
const BLOCK_LIMIT = 50000;
const MAX_PARAM = 256;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Fixed patterns, not user-editable: OpenAI/Anthropic-style keys, AWS access keys, GitHub tokens, JWTs.
const REDACT_PATTERN =
  "/(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]{8,})/";

export function compilePattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 4096) {
    throw new Error("Regex must contain 1–4096 characters");
  }
  // Accept a bare pattern or /pattern/flags. Always replace globally.
  const literal = pattern.match(/^\/([\s\S]*)\/([a-z]*)$/);
  const source = literal ? literal[1] : pattern;
  const flags = literal ? literal[2] : "";
  if (/[^gimsu]/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error("Regex flags may include g, i, m, s and u once each");
  }
  return new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
}

function param(rule, key, label, pattern) {
  const value = typeof rule[key] === "string" ? rule[key].trim() : "";
  if (!value || value.length > MAX_PARAM) throw new Error(`${label} must contain 1–${MAX_PARAM} characters`);
  if (pattern && !pattern.test(value)) throw new Error(`${label} may only contain letters, numbers, _ : . and -`);
  return value;
}

/**
 * The regex a step runs. Friendly kinds are always compiled here from their
 * parameters (a stored or client-sent regex for them is ignored), so the
 * parameters shown in the dashboard are exactly what runs.
 */
export function stepPattern(rule) {
  const kind = rule.kind ?? "regex";
  if (kind === "regex") return rule.regex;
  if (kind === "redact") return REDACT_PATTERN;
  const end = rule.unclosed ? "|$" : "";
  if (kind === "tag") {
    const tag = escape(param(rule, "tag", "Tag", /^[\w:.-]+$/));
    return `<${tag}(?:\\s[^>]*)?>[\\s\\S]{0,${BLOCK_LIMIT}}?(?:</${tag}>${end})`;
  }
  if (kind === "markers") {
    // Whitespace inside the markers is flexible so `<!-- X -->` matches `<!--X-->`.
    const loose = (text) => text.split(/\s+/).map(escape).join("\\s{0,8}");
    const start = loose(param(rule, "start", "Start marker"));
    const stop = loose(param(rule, "end", "End marker"));
    return `${start}[\\s\\S]{0,${BLOCK_LIMIT}}?(?:${stop}${end})`;
  }
  if (kind === "details") {
    const title = escape(param(rule, "title", "Section title"));
    // Matches one level of nested <details> inside the section.
    return `/<details>\\s*<summary>[^<]*${title}[^<]*<\\/summary>(?:[^<]|<(?!\\/?details\\b)|<details>[\\s\\S]*?<\\/details>)*?<\\/details>/`;
  }
  throw new Error(`Unknown step kind: ${kind}`);
}

/** Required text fields per step kind, with the label used in validation errors. */
export const STEP_REQUIRED_FIELDS = {
  regex: { regex: "Regex" },
  tag: { tag: "Tag" },
  markers: { start: "Start marker", end: "End marker" },
  details: { title: "Section title" },
  redact: {},
};

/** First required field of a step that is still blank ({ key, label }), or null. */
export function blankRequiredField(rule) {
  const fields = STEP_REQUIRED_FIELDS[rule?.kind ?? "regex"] ?? {};
  for (const [key, label] of Object.entries(fields)) {
    if (typeof rule[key] !== "string" || !rule[key].trim()) return { key, label };
  }
  return null;
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object") throw new Error("Invalid rule");
  const kind = rule.kind ?? "regex";
  if (!STEP_KINDS.includes(kind)) throw new Error(`Unknown step kind: ${kind}`);
  const blank = blankRequiredField(rule);
  if (blank) throw new Error(`${blank.label} must contain 1–${kind === "regex" ? 4096 : MAX_PARAM} characters`);
  const regex = stepPattern(rule);
  compilePattern(regex);
  const replacement = kind === "redact" ? "[redacted]" : (rule.replacement ?? "");
  const depth = kind === "redact" ? 0 : (rule.depth ?? 0);
  if (typeof replacement !== "string" || replacement.length > 16384) throw new Error("Replacement must be a string of at most 16384 characters");
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("Depth must be a non-negative integer");
  if (rule.label !== undefined && (typeof rule.label !== "string" || rule.label.length > 120)) throw new Error("Label must be at most 120 characters");
  // Plain regex rules keep the original { regex, replacement, depth } shape.
  const out = kind === "regex" ? { regex, replacement, depth } : { kind, regex, replacement, depth };
  if (rule.label) out.label = rule.label;
  if (rule.enabled === false) out.enabled = false;
  if (kind === "tag") out.tag = rule.tag.trim();
  if (kind === "markers") Object.assign(out, { start: rule.start.trim(), end: rule.end.trim() });
  if (kind === "details") out.title = rule.title.trim();
  if ((kind === "tag" || kind === "markers") && rule.unclosed) out.unclosed = true;
  return out;
}

function stringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item || item.length > 200)) {
    throw new Error(`${label} must be a list of at most 100 names`);
  }
  return [...new Set(value)];
}

export function validatePipelines(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length > 50) {
    throw new Error("Provide an array of at most 50 pipelines");
  }
  const names = new Set();
  return pipelines.map((pipeline) => {
    if (!pipeline || typeof pipeline.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(pipeline.name)) {
      throw new Error("Pipeline names must contain 1–64 letters, numbers, underscores or hyphens");
    }
    if (names.has(pipeline.name)) throw new Error(`Duplicate pipeline name: ${pipeline.name}`);
    names.add(pipeline.name);
    if (!Array.isArray(pipeline.rules) || !pipeline.rules.length || pipeline.rules.length > 50) {
      throw new Error(`Pipeline ${pipeline.name} must have 1–50 rules`);
    }
    if (pipeline.description !== undefined && (typeof pipeline.description !== "string" || pipeline.description.length > 500)) {
      throw new Error(`Pipeline ${pipeline.name}: description must be at most 500 characters`);
    }
    const out = {
      name: pipeline.name,
      rules: pipeline.rules.map((rule, index) => {
        try {
          return validateRule(rule);
        } catch (error) {
          throw new Error(`${pipeline.name}, rule ${index + 1}: ${error.message}`);
        }
      }),
    };
    if (pipeline.description) out.description = pipeline.description;
    const keys = stringList(pipeline.attach?.keys, `Pipeline ${pipeline.name}: attached keys`);
    const combos = stringList(pipeline.attach?.combos, `Pipeline ${pipeline.name}: attached combos`);
    if (keys.length || combos.length) out.attach = { keys, combos };
    return out;
  });
}

/**
 * Pipelines for one request, in run order: attached to the API key, then
 * attached to the requested combo, then the one the header names. A header
 * only adds a pipeline; it cannot skip one attached to the key or combo.
 * Each pipeline runs at most once.
 */
export function selectPipelines(pipelines, { header, keyId, combo } = {}) {
  const list = pipelines ?? [];
  const selected = [];
  const add = (pipeline) => { if (!selected.includes(pipeline)) selected.push(pipeline); };
  if (keyId) list.filter((p) => p.attach?.keys?.includes(keyId)).forEach(add);
  if (combo) {
    const name = combo.toLowerCase();
    list.filter((p) => p.attach?.combos?.some((c) => c.toLowerCase() === name)).forEach(add);
  }
  if (header !== null && header !== undefined) {
    const found = list.find((p) => p.name === header.trim());
    if (!found) throw new Error(`Unknown request pipeline: ${header}`);
    add(found);
  }
  return selected;
}

export const hasKeyAttachments = (pipelines) => (pipelines ?? []).some((p) => p.attach?.keys?.length);
