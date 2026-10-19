import { FORMATS } from "../formats.js";
import { PROVIDERS } from "../../config/providers.js";

/**
 * Ask an OpenAI Chat Completions upstream for real token usage on a stream.
 *
 * Without `stream_options.include_usage` most OpenAI-compatible upstreams send
 * no usage at all when streaming, and the gateway falls back to a length-based
 * estimate, which is what per-key pricing and budgets then bill. With it, the
 * upstream appends one extra chunk (`choices: []`, `usage: {...}`) before
 * [DONE]; the stream layer folds that into the finish chunk and drops it again
 * when the client did not ask for it (see createSSEStream `streamUsage`).
 *
 * Opt-outs, any of which skips the field:
 * - registry: `transport.quirks.noStreamUsageOption: true` (known strict APIs)
 * - connection/node: `providerSpecificData.streamUsage === false`
 * - learned: an upstream that rejected the field once (rememberStreamUsageRejected)
 *
 * @returns {boolean} true when this call added the option (the client did not send one)
 */
export function requestStreamUsage(upstreamBody, provider, upstreamFormat, stream, credentials = null) {
  if (!stream || upstreamFormat !== FORMATS.OPENAI) return false;
  if (!upstreamBody || typeof upstreamBody !== "object" || !Array.isArray(upstreamBody.messages)) return false;
  if (PROVIDERS[provider]?.quirks?.noStreamUsageOption === true) return false;
  if (credentials?.providerSpecificData?.streamUsage === false) return false;
  if (rejectedTargets.has(targetKey(provider, credentials))) return false;
  if (upstreamBody.stream_options !== undefined) return false;
  upstreamBody.stream_options = { include_usage: true };
  return true;
}

/** Whether the client itself asked for the usage-only trailer chunk. */
export function clientRequestedStreamUsage(clientBody) {
  return clientBody?.stream_options?.include_usage === true;
}

// Upstreams (provider + base URL, so each custom node is its own entry) that
// rejected stream_options. In-memory: a restart re-learns it with one retry.
const rejectedTargets = new Set();
const MAX_REMEMBERED = 1000;

function targetKey(provider, credentials) {
  return `${provider}|${credentials?.providerSpecificData?.baseUrl || ""}`;
}

export function rememberStreamUsageRejected(provider, credentials) {
  if (rejectedTargets.size >= MAX_REMEMBERED) rejectedTargets.clear();
  rejectedTargets.add(targetKey(provider, credentials));
}

/** Test hook. */
export function forgetStreamUsageRejections() {
  rejectedTargets.clear();
}

const REJECTION_STATUSES = new Set([400, 422]);
const REJECTION_PATTERN = /stream_options|include_usage/i;

/**
 * True when an error response rejects the stream_options field. Reads a clone,
 * so the original response stays readable for normal error handling.
 */
export async function isStreamUsageRejection(response) {
  if (!response || response.ok || !REJECTION_STATUSES.has(response.status)) return false;
  try {
    const text = await response.clone().text();
    return REJECTION_PATTERN.test(text);
  } catch {
    return false;
  }
}
