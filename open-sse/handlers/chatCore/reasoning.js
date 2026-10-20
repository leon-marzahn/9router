// Reasoning text on non-streaming OpenAI-shaped responses.
//
// OpenAI Chat Completions clients get `reasoning_content` only when the answer
// is empty (a thinking model that spent all tokens on reasoning): otherwise it
// is stripped, as the upstream behaviour they were built against (#542).
// Gemini-native clients (/v1beta/models/...:generateContent) are different:
// the route turns `reasoning_content` into a `thought: true` part, exactly as
// its streaming twin does for every delta, so it must survive here or
// non-streaming and streaming answers disagree.

// Client endpoints whose route renders reasoning as its own content part.
const REASONING_KEEPING_ENDPOINTS = ["/v1beta/models/"];

export function clientKeepsReasoning(endpoint) {
  return typeof endpoint === "string" && REASONING_KEEPING_ENDPOINTS.some((p) => endpoint.includes(p));
}

/** Drop reasoning_content from choices that also carry an answer, unless the client keeps it. */
export function stripAnsweredReasoning(choices, endpoint) {
  if (!Array.isArray(choices) || clientKeepsReasoning(endpoint)) return;
  for (const choice of choices) {
    if (choice?.message?.reasoning_content && choice.message.content) {
      delete choice.message.reasoning_content;
    }
  }
}
