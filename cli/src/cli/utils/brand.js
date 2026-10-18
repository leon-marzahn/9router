// Brand names written into third-party tool configs (opencode, codex, crush, …).
// The fork was renamed from "9Router" to "Elizabeth's Proxy" (machine name `regent`).
// New writes use PROVIDER_KEY and drop any LEGACY_PROVIDER_KEY entry; reads accept
// both (current first); removals drop both.
// Copy of src/shared/constants/brand.js (the CLI package ships separately) — keep in sync.

const DISPLAY_NAME = "Elizabeth's Proxy";
/** Display name pre-rebrand installs wrote into tool configs (e.g. Copilot entry name). */
const LEGACY_DISPLAY_NAME = "9Router";
const PROVIDER_KEY = "regent";
const LEGACY_PROVIDER_KEY = "9router";
/** Current key first, then legacy — the lookup order for reads. */
const PROVIDER_KEYS = [PROVIDER_KEY, LEGACY_PROVIDER_KEY];

/** First present entry of `obj` under the current or legacy key. */
const pickProvider = (obj) => {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of PROVIDER_KEYS) if (obj[key] != null) return obj[key];
  return undefined;
};

/** Delete both the current and legacy keys from `obj` (no-op on non-objects). */
const deleteProviderKeys = (obj) => {
  if (!obj || typeof obj !== "object") return;
  for (const key of PROVIDER_KEYS) delete obj[key];
};

/** True when `modelId` is prefixed with `regent/` or legacy `9router/`. */
const hasProviderPrefix = (modelId) =>
  typeof modelId === "string" && PROVIDER_KEYS.some((k) => modelId.startsWith(`${k}/`));

/** Strip a `regent/` or `9router/` prefix. */
const stripProviderPrefix = (modelId) => {
  if (typeof modelId !== "string") return modelId;
  for (const k of PROVIDER_KEYS) if (modelId.startsWith(`${k}/`)) return modelId.slice(k.length + 1);
  return modelId;
};

/** `regent/<model>` */
const prefixModel = (modelId) => `${PROVIDER_KEY}/${modelId}`;

/** Case-insensitive: does `text` (e.g. a base URL) mention either brand name? */
const mentionsBrand = (text) => {
  const s = String(text || "").toLowerCase();
  return PROVIDER_KEYS.some((k) => s.includes(k));
};

module.exports = {
  DISPLAY_NAME,
  LEGACY_DISPLAY_NAME,
  PROVIDER_KEY,
  LEGACY_PROVIDER_KEY,
  PROVIDER_KEYS,
  pickProvider,
  deleteProviderKeys,
  hasProviderPrefix,
  stripProviderPrefix,
  prefixModel,
  mentionsBrand,
};
