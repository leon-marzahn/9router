import { parseTOML } from "confbox";
import { assertConfigValue } from "../configText.js";

// Our keys in ~/.deepseek/config.toml: `provider = "openai"` and base_url / api_key / model
// under [providers.openai]. Everything else in the file is the user's and is kept.
const OUR_OPENAI_KEYS = ["base_url", "api_key", "model"];

export const parseExistingToml = (content) => {
    if (!content.trim()) return {};
    try {
        return parseTOML(content) || {};
    } catch {
        const error = new Error("~/.deepseek/config.toml is not valid TOML; fix or remove it first");
        error.status = 409;
        throw error;
    }
};

export const applyRegentConfig = (config, baseUrl, apiKey, model) => {
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    const openai = providers.openai && typeof providers.openai === "object" ? providers.openai : {};
    const next = { ...openai, base_url: assertConfigValue(normalizedBaseUrl, "Base URL"), model: assertConfigValue(model, "Model") };
    if (apiKey) next.api_key = assertConfigValue(apiKey, "API key");
    else delete next.api_key;
    return { ...config, provider: "openai", providers: { ...providers, openai: next } };
};

export const removeRegentConfig = (config) => {
    const next = { ...config };
    if (next.provider === "openai") delete next.provider;
    const openai = next.providers?.openai;
    if (openai && typeof openai === "object") {
        const rest = { ...openai };
        for (const key of OUR_OPENAI_KEYS) delete rest[key];
        const providers = { ...next.providers };
        if (Object.keys(rest).length) providers.openai = rest;
        else delete providers.openai;
        if (Object.keys(providers).length) next.providers = providers;
        else delete next.providers;
    }
    return next;
};
