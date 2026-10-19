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
 * Providers whose API rejects the field opt out in their registry entry with
 * `transport.quirks.noStreamUsageOption: true`.
 *
 * @returns {boolean} true when this call added the option (the client did not send one)
 */
export function requestStreamUsage(upstreamBody, provider, upstreamFormat, stream) {
  if (!stream || upstreamFormat !== FORMATS.OPENAI) return false;
  if (!upstreamBody || typeof upstreamBody !== "object" || !Array.isArray(upstreamBody.messages)) return false;
  if (PROVIDERS[provider]?.quirks?.noStreamUsageOption === true) return false;
  if (upstreamBody.stream_options !== undefined) return false;
  upstreamBody.stream_options = { include_usage: true };
  return true;
}

/** Whether the client itself asked for the usage-only trailer chunk. */
export function clientRequestedStreamUsage(clientBody) {
  return clientBody?.stream_options?.include_usage === true;
}
