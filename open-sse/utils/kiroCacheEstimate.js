// Kiro never reports cache counts, but it caches by prefix per conversation.
// A request that carries a stable conversation id therefore has everything the
// previous request sent already cached, up to the point where the two diverge:
//   - time context off: the previous request's last user message comes back
//     unchanged, so the cache reaches that message.
//   - time context on: that message went out with a timestamp and comes back
//     without one, so the cache stops at the assistant message before it.
//     Exception: the very first message, which session replay keeps frozen.
// cached = previous prompt (minus that last user message when time was on).
// Prompt sizes are themselves approximations (context percentage), so this is
// an estimate. State is in memory and a restart simply forgets it (cached = 0).

const MAX_CONVERSATIONS = 5000;
const TIME_CONTEXT_RE = /\[Context: Current time is /;

const previous = new Map(); // conversationId -> { prompt, timeStrippedTokens }

const approxTokens = (text) => Math.ceil((text ? text.length : 0) / 4);

/**
 * Pull what the estimator needs out of the Kiro payload sent upstream.
 * @returns {{conversationId: string, lastUserTokens: number, timeAdded: boolean} | null}
 */
export function buildKiroCacheContext(body) {
  const state = body?.conversationState;
  const conversationId = state?.conversationId;
  const message = state?.currentMessage?.userInputMessage;
  if (!conversationId || !message) return null;
  const content = typeof message.content === "string" ? message.content : "";
  const toolResults = message.userInputMessageContext?.toolResults;
  const resultText = Array.isArray(toolResults) ? JSON.stringify(toolResults) : "";
  return {
    conversationId,
    lastUserTokens: approxTokens(content) + approxTokens(resultText),
    timeAdded: TIME_CONTEXT_RE.test(content),
    // Session replay freezes the first message (timestamp included), so it still
    // matches the cache on the next turn. Only later messages lose their stamp.
    isFirstTurn: !(Array.isArray(state.history) && state.history.length > 0),
  };
}

/**
 * @param {{conversationId: string, lastUserTokens: number, timeAdded: boolean} | null} context
 * @param {number} promptTokens total prompt tokens of this request
 * @returns {number} estimated cached prompt tokens (0 when nothing earlier is known)
 */
export function estimateKiroCachedTokens(context, promptTokens) {
  if (!context?.conversationId || !(promptTokens > 0)) return 0;
  const before = previous.get(context.conversationId);

  previous.delete(context.conversationId);
  if (previous.size >= MAX_CONVERSATIONS) previous.delete(previous.keys().next().value);
  previous.set(context.conversationId, {
    prompt: promptTokens,
    timeStrippedTokens: context.timeAdded && !context.isFirstTurn ? context.lastUserTokens : 0,
  });

  if (!before) return 0;
  const cached = before.prompt - before.timeStrippedTokens;
  return Math.max(0, Math.min(cached, promptTokens));
}

/** Test helper. */
export function resetKiroCacheEstimator() {
  previous.clear();
}
