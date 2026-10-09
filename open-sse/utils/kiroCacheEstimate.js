// Kiro never reports cache counts, but it caches by prefix, keyed on content (not on any
// session id) and only for a few minutes. So the estimate follows the content:
//   - key: connection, model and the conversation's first message (system prompt included).
//     The first message is the same on every turn (session replay freezes it), so every turn
//     of a chat, and a new chat that opens identically, land on one entry.
//   - what is cached: everything the previous request sent, up to where the two diverge:
//       - time context off: the previous last user message comes back unchanged.
//       - time context on: that message went out with a timestamp and comes back without one,
//         so the cache stops at the assistant message before it. Exception: the first message,
//         which replay keeps frozen, timestamp included.
//   - the newest user message is new, so cached never exceeds prompt minus that message.
//     Exception: an exact repeat (same history, same last message), which Kiro serves whole.
//   - Kiro drops an idle prefix after about five minutes (measured between 3.5 and 6 minutes,
//     and a hit extends it), so an entry older than that no longer counts.
// Prompt sizes are themselves approximations (context percentage), so this is an estimate.
// State is in memory and a restart simply forgets it (cached = 0).

import { createHash } from "node:crypto";

const MAX_ENTRIES = 5000;
const TTL_MS = 5 * 60 * 1000;
const TIME_CONTEXT_RE = /\[Context: Current time is /;

const previous = new Map(); // key -> { prompt, timeStrippedTokens, lastHash, historyLength, at }

const approxTokens = (text) => Math.ceil((text ? text.length : 0) / 4);
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Pull what the estimator needs out of the Kiro payload sent upstream.
 * @param {object} body Kiro request body
 * @param {string} [scope] connection id; Kiro's cache is per account
 * @returns {{key: string, lastHash: string, lastUserTokens: number, timeAdded: boolean,
 *   isFirstTurn: boolean, historyLength: number} | null}
 */
export function buildKiroCacheContext(body, scope = "") {
  const state = body?.conversationState;
  const message = state?.currentMessage?.userInputMessage;
  if (!message) return null;
  const history = Array.isArray(state.history) ? state.history : [];
  const start = history.find((h) => h?.userInputMessage)?.userInputMessage || message;
  const startText = typeof start.content === "string" ? start.content : "";
  if (!startText) return null;
  const content = typeof message.content === "string" ? message.content : "";
  const toolResults = message.userInputMessageContext?.toolResults;
  const resultText = Array.isArray(toolResults) ? JSON.stringify(toolResults) : "";
  return {
    key: digest(`${scope}\n${message.modelId || start.modelId || ""}\n${startText}`),
    lastHash: digest(`${content}\n${resultText}`),
    lastUserTokens: approxTokens(content) + approxTokens(resultText),
    timeAdded: TIME_CONTEXT_RE.test(content),
    // Session replay freezes the first message (timestamp included), so it still
    // matches the cache on the next turn. Only later messages lose their stamp.
    isFirstTurn: history.length === 0,
    historyLength: history.length,
  };
}

/**
 * @param {ReturnType<typeof buildKiroCacheContext>} context
 * @param {number} promptTokens total prompt tokens of this request
 * @returns {number} estimated cached prompt tokens (0 when nothing earlier is known)
 */
export function estimateKiroCachedTokens(context, promptTokens) {
  if (!context?.key || !(promptTokens > 0)) return 0;
  const now = Date.now();
  const before = previous.get(context.key);

  previous.delete(context.key);
  if (previous.size >= MAX_ENTRIES) previous.delete(previous.keys().next().value);
  previous.set(context.key, {
    prompt: promptTokens,
    timeStrippedTokens: context.timeAdded && !context.isFirstTurn ? context.lastUserTokens : 0,
    lastHash: context.lastHash,
    historyLength: context.historyLength,
    at: now,
  });

  if (!before || now - before.at > TTL_MS) return 0;
  const repeat = before.lastHash === context.lastHash && before.historyLength === context.historyLength;
  if (repeat) return Math.max(0, Math.min(before.prompt, promptTokens));
  const cached = before.prompt - before.timeStrippedTokens;
  // The newest user message is new, so a changed request can never be a full hit.
  return Math.max(0, Math.min(cached, promptTokens - context.lastUserTokens));
}

/** Test helper. */
export function resetKiroCacheEstimator() {
  previous.clear();
}
