import { DISPLAY_NAME, PROVIDER_KEY, LEGACY_PROVIDER_KEY } from "@/shared/constants/brand.js";
import { tomlString } from "@/app/api/cli-tools/configText.js";

export const GROK_MAIN_MODEL_SLOT = PROVIDER_KEY;
const LEGACY_MAIN_MODEL_SLOT = LEGACY_PROVIDER_KEY;
export const GROK_BUILTIN_DEFAULT = "grok-build";
export const GROK_SUBAGENT_TYPES = ["general-purpose", "explore", "plan"];

const UNSET_SENTINEL = `__${PROVIDER_KEY}_unset__`;
const LEGACY_UNSET_SENTINEL = `__${LEGACY_PROVIDER_KEY}_unset__`;
const MODELS_SECTION = "models";
const SUBAGENT_MODELS_SECTION = "subagents.models";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sectionRegExp = (section) =>
  new RegExp(
    `^\\[${escapeRegExp(section)}\\][ \\t]*\\r?\\n((?:(?!\\[)[^\\r\\n]*\\r?\\n?)*)`,
    "m",
  );

const modelSlot = (type) => `${GROK_MAIN_MODEL_SLOT}-${type}`;

const previousDefaultRegExp = new RegExp(
  `^# ${escapeRegExp(PROVIDER_KEY)}-prev-default = "([^"]*)"[ \\t]*\\r?\\n?`,
  "m",
);
const previousSubagentRegExp = (type) =>
  new RegExp(
    `^# ${escapeRegExp(PROVIDER_KEY)}-prev-subagent-${escapeRegExp(type)} = "([^"]*)"[ \\t]*\\r?\\n?`,
    "m",
  );

function getSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"([^"]*)"`, "m"),
  );
  return field ? field[1] : null;
}

function getSectionNumber(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return null;
  const field = match[1].match(
    new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*([0-9]+(?:\\.[0-9]+)?)`, "m"),
  );
  if (!field) return null;
  const value = Number(field[1]);
  return Number.isFinite(value) ? value : null;
}

function setSectionField(toml, section, key, value) {
  const match = toml.match(sectionRegExp(section));
  const line = `${key} = ${tomlString(value)}`;
  if (!match) {
    const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
    return `${prefix}\n[${section}]\n${line}\n`;
  }

  const body = match[1] || "";
  const fieldRegExp = new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*"[^"]*"`,
    "m",
  );
  const nextBody = fieldRegExp.test(body)
    ? body.replace(fieldRegExp, line)
    : `${line}\n${body}`;
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function deleteSectionField(toml, section, key) {
  const match = toml.match(sectionRegExp(section));
  if (!match) return toml;
  const fieldRegExp = new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[^\\r\\n]*\\r?\\n?`,
    "m",
  );
  const nextBody = (match[1] || "").replace(fieldRegExp, "");
  if (!nextBody.trim()) return toml.replace(match[0], "").replace(/\n{3,}/g, "\n\n");
  return toml.replace(match[0], `[${section}]\n${nextBody}`);
}

function parseModelSection(toml, slot) {
  const match = toml.match(sectionRegExp(`model.${slot}`));
  if (!match) return null;
  const body = match[1] || "";
  const contextWindow = getSectionNumber(toml, `model.${slot}`, "context_window");
  return {
    model: getSectionField(toml, `model.${slot}`, "model"),
    base_url: getSectionField(toml, `model.${slot}`, "base_url"),
    name: getSectionField(toml, `model.${slot}`, "name"),
    api_key: getSectionField(toml, `model.${slot}`, "api_key"),
    api_backend: getSectionField(toml, `model.${slot}`, "api_backend"),
    context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    raw: body,
  };
}

function buildModelSection({ slot, model, baseUrl, apiKey, contextWindow, name }) {
  const lines = [
    `[model.${slot}]`,
    `model = ${tomlString(model)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(`Routed via ${DISPLAY_NAME} gateway`)}`,
    `api_backend = "chat_completions"`,
  ];
  if (apiKey) lines.push(`api_key = ${tomlString(apiKey)}`);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    lines.push(`context_window = ${Math.floor(contextWindow)}`);
  }
  return `${lines.join("\n")}\n`;
}

function upsertModelSection(toml, config) {
  const regexp = sectionRegExp(`model.${config.slot}`);
  const section = buildModelSection(config);
  if (regexp.test(toml)) return toml.replace(regexp, section);
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}\n${section}`;
}

function removeModelSection(toml, slot) {
  return toml.replace(sectionRegExp(`model.${slot}`), "").replace(/\n{3,}/g, "\n\n");
}

function insertMarker(toml, marker) {
  const mainSection = sectionRegExp(`model.${GROK_MAIN_MODEL_SLOT}`);
  if (mainSection.test(toml)) {
    return toml.replace(mainSection, (section) => `${marker}${section}`);
  }
  const prefix = toml.length > 0 && !toml.endsWith("\n") ? `${toml}\n` : toml;
  return `${prefix}${marker}`;
}

function rememberPreviousDefault(toml) {
  if (previousDefaultRegExp.test(toml)) return toml;
  const current = getSectionField(toml, MODELS_SECTION, "default");
  if (!current || current === GROK_MAIN_MODEL_SLOT) return toml;
  return insertMarker(toml, `# ${PROVIDER_KEY}-prev-default = ${tomlString(current)}\n`);
}

function restorePreviousDefault(toml) {
  const previous = toml.match(previousDefaultRegExp)?.[1] || GROK_BUILTIN_DEFAULT;
  let next = toml.replace(previousDefaultRegExp, "");
  if (getSectionField(next, MODELS_SECTION, "default") === GROK_MAIN_MODEL_SLOT) {
    next = setSectionField(next, MODELS_SECTION, "default", previous);
  }
  return next;
}

function rememberPreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  if (regexp.test(toml)) return toml;
  const current = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
  const previous = current == null ? UNSET_SENTINEL : current;
  return insertMarker(
    toml,
    `# ${PROVIDER_KEY}-prev-subagent-${type} = ${tomlString(previous)}\n`,
  );
}

function restorePreviousSubagent(toml, type) {
  const regexp = previousSubagentRegExp(type);
  const previous = toml.match(regexp)?.[1] || UNSET_SENTINEL;
  let next = toml.replace(regexp, "");
  if (getSectionField(next, SUBAGENT_MODELS_SECTION, type) !== modelSlot(type)) {
    return next;
  }
  if (previous === UNSET_SENTINEL) {
    return deleteSectionField(next, SUBAGENT_MODELS_SECTION, type);
  }
  return setSectionField(next, SUBAGENT_MODELS_SECTION, type, previous);
}

/**
 * Rename everything a pre-rebrand install wrote under the legacy `9router` slot names
 * (`[model.9router]`, `[model.9router-<type>]`, `default = "9router"`, subagent mappings,
 * `# 9router-prev-*` markers) to the current `regent` names, so parse/apply/reset only
 * deal with one set of names. When a current-named section already exists the legacy
 * duplicate is dropped instead. No-op for configs without legacy names.
 */
export function migrateLegacyGrokBuildConfig(toml) {
  if (!toml || !toml.includes(LEGACY_MAIN_MODEL_SLOT)) return toml;
  let next = toml;
  const slots = [
    [LEGACY_MAIN_MODEL_SLOT, GROK_MAIN_MODEL_SLOT],
    ...GROK_SUBAGENT_TYPES.map((type) => [`${LEGACY_MAIN_MODEL_SLOT}-${type}`, modelSlot(type)]),
  ];
  for (const [legacy, current] of slots) {
    const legacySection = sectionRegExp(`model.${legacy}`);
    if (!legacySection.test(next)) continue;
    next = sectionRegExp(`model.${current}`).test(next)
      ? removeModelSection(next, legacy)
      : next.replace(new RegExp(`^\\[model\\.${escapeRegExp(legacy)}\\]`, "m"), `[model.${current}]`);
  }
  if (getSectionField(next, MODELS_SECTION, "default") === LEGACY_MAIN_MODEL_SLOT) {
    next = setSectionField(next, MODELS_SECTION, "default", GROK_MAIN_MODEL_SLOT);
  }
  for (const type of GROK_SUBAGENT_TYPES) {
    if (getSectionField(next, SUBAGENT_MODELS_SECTION, type) === `${LEGACY_MAIN_MODEL_SLOT}-${type}`) {
      next = setSectionField(next, SUBAGENT_MODELS_SECTION, type, modelSlot(type));
    }
  }
  const legacyMarker = new RegExp(`^# ${escapeRegExp(LEGACY_MAIN_MODEL_SLOT)}-prev-`, "gm");
  next = next.replace(legacyMarker, `# ${GROK_MAIN_MODEL_SLOT}-prev-`);
  return next.split(tomlString(LEGACY_UNSET_SENTINEL)).join(tomlString(UNSET_SENTINEL));
}

export function parseGrokBuildConfig(rawToml) {
  const toml = migrateLegacyGrokBuildConfig(rawToml);
  const subagentModels = {};
  const subagentMappings = {};
  for (const type of GROK_SUBAGENT_TYPES) {
    const mapping = getSectionField(toml, SUBAGENT_MODELS_SECTION, type);
    subagentMappings[type] = mapping;
    subagentModels[type] = mapping === modelSlot(type)
      ? parseModelSection(toml, mapping)
      : null;
  }

  return {
    model: parseModelSection(toml, GROK_MAIN_MODEL_SLOT),
    default: getSectionField(toml, MODELS_SECTION, "default"),
    subagentModels,
    subagentMappings,
  };
}

/**
 * Apply main model and optional per-type subagent overrides while preserving all unrelated TOML.
 * `subagentModels === undefined` leaves existing subagent config untouched for API compatibility.
 */
export function applyGrokBuildConfig(
  toml,
  { baseUrl, apiKey, model, contextWindow, subagentModels },
) {
  let next = rememberPreviousDefault(migrateLegacyGrokBuildConfig(toml));
  next = upsertModelSection(next, {
    slot: GROK_MAIN_MODEL_SLOT,
    model,
    baseUrl,
    apiKey,
    contextWindow,
    name: DISPLAY_NAME,
  });
  next = setSectionField(next, MODELS_SECTION, "default", GROK_MAIN_MODEL_SLOT);

  if (subagentModels && typeof subagentModels === "object") {
    for (const type of GROK_SUBAGENT_TYPES) {
      const selected = subagentModels[type];
      const slot = modelSlot(type);
      if (selected?.model) {
        next = rememberPreviousSubagent(next, type);
        next = upsertModelSection(next, {
          slot,
          model: selected.model,
          baseUrl,
          apiKey,
          contextWindow: selected.contextWindow,
          name: `${DISPLAY_NAME} ${type}`,
        });
        next = setSectionField(next, SUBAGENT_MODELS_SECTION, type, slot);
      } else {
        next = restorePreviousSubagent(next, type);
        next = removeModelSection(next, slot);
      }
    }
  }

  return next;
}

export function resetGrokBuildConfig(toml) {
  let next = migrateLegacyGrokBuildConfig(toml);
  for (const type of GROK_SUBAGENT_TYPES) {
    next = restorePreviousSubagent(next, type);
    next = removeModelSection(next, modelSlot(type));
  }
  next = removeModelSection(next, GROK_MAIN_MODEL_SLOT);
  next = restorePreviousDefault(next);
  return next.replace(/\n{3,}/g, "\n\n");
}

export function getGrokSubagentSlot(type) {
  return GROK_SUBAGENT_TYPES.includes(type) ? modelSlot(type) : null;
}
