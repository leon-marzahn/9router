import { getModelInfo } from "../services/model.js";
import { getProviderCredentials, clearAccountError } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

// Usage rows for the routing decision carry this endpoint, so a key's bill shows what
// the classification cost next to the answer it routed.
export const SMART_ROUTER_ENDPOINT = "smart-router";

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * The router model is the operator's choice per combo; there is no implicit default,
 * because the last user turn (up to 2000 chars) is sent to it. Its usage is recorded
 * against the calling API key.
 *
 * Never throws: on missing credentials, timeout, or upstream failure, returns null
 * so combo dispatch fails open to standard model ordering.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} opts.routerModel - System One router model (required)
 * @param {object} [opts.log] - Logger
 * @param {string|null} [opts.apiKey] - Calling API key, for usage attribution
 * @param {string} [opts.comboName] - Combo name, recorded as the requested model
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation
 * @returns {Promise<{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null>}
 */
export async function resolveSmartChoice({
  body,
  models,
  routerModel,
  log,
  apiKey = null,
  comboName = null,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
}) {
  if (!Array.isArray(models) || models.length <= 1) return null;

  const targetModel = typeof routerModel === "string" ? routerModel.trim() : "";
  if (!targetModel) return null;

  const state = extractPromptState(body);
  if (!state) {
    log?.debug?.("COMBO", "smart-router: empty prompt state, skipping classification");
    return null;
  }

  const criteria = buildChoiceCriteria(models);
  if (Object.keys(criteria).length === 0) return null;

  try {
    const modelInfo = await getModelInfo(targetModel);
    if (!modelInfo?.provider) {
      log?.warn?.("COMBO", `smart-router: unrecognized router model "${targetModel}"`);
      return null;
    }

    const { provider, model } = modelInfo;
    const credentials = await getProviderCredentials(provider, new Set(), model);
    if (!credentials || credentials.allRateLimited) {
      log?.warn?.("COMBO", `smart-router: no credentials available for router provider "${provider}"`);
      return null;
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    const systemoneBody = {
      model,
      state,
      questions: {
        route: {
          type: "choice",
          instructions: "Which of these configured models is the most appropriate for this request?",
          criteria,
        },
      },
    };

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`System One router timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const corePromise = handleSystemoneCore({
      body: systemoneBody,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });
    // A late answer after the timeout is dropped; keep its rejection off the floor.
    corePromise.catch(() => {});

    let result;
    try {
      result = await Promise.race([corePromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!result?.success || !result.response) {
      log?.warn?.("COMBO", `smart-router: evaluation failed (${result?.status || "error"})`);
      return null;
    }

    if (result.usage) {
      const prompt = Number(result.usage.prompt_tokens) || 0;
      const completion = Number(result.usage.completion_tokens) || 0;
      saveRequestUsage({
        provider,
        model,
        requestedModel: comboName || targetModel,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint: SMART_ROUTER_ENDPOINT,
        tokens: { ...result.usage, total_tokens: prompt + completion },
        status: "success",
      }).catch(() => {});
    }

    const json = await result.response.json();
    const route = parseSystemOneRouteAnswer(json);
    if (!route || !route.choice) {
      log?.warn?.("COMBO", "smart-router: response missing valid route choice");
      return null;
    }

    return route;
  } catch (err) {
    log?.warn?.("COMBO", `smart-router: evaluation aborted (${err?.message || String(err)})`);
    return null;
  }
}
