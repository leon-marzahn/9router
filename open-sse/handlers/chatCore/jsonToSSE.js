// Replay a complete (non-streaming) response as an SSE stream in the client's
// wire format. Used when the client asked to stream but the upstream ignored
// `stream` and answered with one JSON document: the response has already been
// translated to the client's format and its usage recorded by the
// non-streaming handler; SDKs iterating SSE still need events, not JSON.
import { FORMATS } from "../../translator/formats.js";
import { formatSSE } from "../../utils/streamHelpers.js";
import { SSE_HEADERS_CORS } from "../../utils/sseConstants.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";

/** Client formats this module can replay. Others keep the JSON response. */
export const JSON_REPLAY_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

function openAIChatEvents(json, { includeUsage = false, realUsage = null } = {}) {
  const base = { id: json.id, object: "chat.completion.chunk", created: json.created, model: json.model };
  const events = [];
  for (const choice of json.choices || []) {
    const index = choice.index ?? 0;
    const msg = choice.message || {};
    events.push({ ...base, choices: [{ index, delta: { role: msg.role || "assistant", content: "" }, finish_reason: null }] });
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      events.push({ ...base, choices: [{ index, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }] });
    }
    if (typeof msg.content === "string" && msg.content) {
      events.push({ ...base, choices: [{ index, delta: { content: msg.content }, finish_reason: null }] });
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const toolCalls = msg.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: tc.type || "function", function: tc.function }));
      events.push({ ...base, choices: [{ index, delta: { tool_calls: toolCalls }, finish_reason: null }] });
    }
    events.push({ ...base, choices: [{ index, delta: {}, finish_reason: choice.finish_reason || "stop" }] });
  }
  if (json.usage && events.length) events[events.length - 1].usage = json.usage;
  // stream_options.include_usage: the usage-only trailer carries the real count.
  const trailerUsage = realUsage || json.usage;
  if (includeUsage && trailerUsage) events.push({ ...base, choices: [], usage: trailerUsage });
  return events.map((e) => formatSSE(e, FORMATS.OPENAI)).join("") + "data: [DONE]\n\n";
}

function claudeEvents(json) {
  const { content = [], usage = {}, stop_reason = "end_turn", stop_sequence = null, ...message } = json;
  const events = [{ type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text || "" } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking || "" } });
      if (block.signature) events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason, stop_sequence }, usage });
  events.push({ type: "message_stop" });
  return events.map((e) => formatSSE(e, FORMATS.CLAUDE)).join("");
}

function responsesEvents(json) {
  let seq = 0;
  const ev = (event, data) => formatSSE({ event, data: { type: event, sequence_number: seq++, ...data } }, FORMATS.OPENAI_RESPONSES);
  const inProgress = { ...json, status: "in_progress", output: [] };
  delete inProgress.usage;
  let out = ev("response.created", { response: inProgress }) + ev("response.in_progress", { response: inProgress });
  (json.output || []).forEach((item, output_index) => {
    out += ev("response.output_item.added", { output_index, item });
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((part, content_index) => {
        const ids = { item_id: item.id, output_index, content_index };
        out += ev("response.content_part.added", { ...ids, part: { ...part, text: "" } });
        if (part.type === "output_text") {
          out += ev("response.output_text.delta", { ...ids, delta: part.text || "" });
          out += ev("response.output_text.done", { ...ids, text: part.text || "" });
        }
        out += ev("response.content_part.done", { ...ids, part });
      });
    }
    out += ev("response.output_item.done", { output_index, item });
  });
  out += ev("response.completed", { response: json });
  return out;
}

const BUILDERS = {
  [FORMATS.OPENAI]: openAIChatEvents,
  [FORMATS.CLAUDE]: claudeEvents,
  [FORMATS.OPENAI_RESPONSES]: responsesEvents,
};

/** SSE text for one complete client-format JSON response. */
export function jsonResponseToSSE(json, sourceFormat, options = {}) {
  const build = BUILDERS[sourceFormat];
  return build ? build(json, options) : null;
}

/**
 * Turn the non-streaming handler's JSON Response into an SSE Response for a
 * streaming client (`includeUsage`: append the OpenAI usage-only trailer the
 * client asked for with stream_options.include_usage). Error results and unknown formats are returned unchanged.
 */
export async function replayJsonResultAsSSE(result, sourceFormat, upstreamHeaders, { includeUsage = false } = {}) {
  if (!result?.success || !result.response || !JSON_REPLAY_FORMATS.has(sourceFormat)) return result;
  let json;
  try { json = await result.response.clone().json(); } catch { return result; }
  const text = jsonResponseToSSE(json, sourceFormat, { includeUsage, realUsage: result.clientUsage || null });
  if (!text) return result;
  return {
    ...result,
    response: new Response(text, { headers: { ...SSE_HEADERS_CORS, ...upstreamResponseHeaders(upstreamHeaders) } }),
  };
}
