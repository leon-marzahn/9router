import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";

/**
 * A combo named like a real model id (e.g. "gpt-5.5") catches requests for
 * that bare model name, because combos are checked first. That's a supported
 * way to give one model several providers, but surprising by accident, so the
 * API returns a non-blocking warning. Returns "provider/model" or null.
 */
export function findShadowedModel(name) {
  if (!name) return null;
  const want = String(name).toLowerCase();
  for (const [provider, models] of Object.entries(PROVIDER_MODELS || {})) {
    for (const m of models || []) {
      if (String(m?.id || "").toLowerCase() === want) return `${provider}/${m.id}`;
    }
  }
  return null;
}

export const shadowWarning = (name) => {
  const model = findShadowedModel(name);
  return model ? { code: "COMBO_NAME_SHADOWS_MODEL", model } : undefined;
};
