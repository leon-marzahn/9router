// Transform an OpenAI chat completion (SSE stream or JSON body) to Ollama's /api/chat format.

const DONE_REASON = { stop: "stop", length: "length", tool_calls: "stop", content_filter: "stop" };

function parseArgs(args) {
  if (args && typeof args === "object") return args;
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

function toolCallsOut(calls) {
  return calls.map((tc) => ({ function: { name: tc.function?.name || "", arguments: parseArgs(tc.function?.arguments) } }));
}

function finalFields(usage, finishReason) {
  const out = { done: true, done_reason: DONE_REASON[finishReason] || "stop" };
  if (usage) {
    if (Number.isFinite(usage.prompt_tokens)) out.prompt_eval_count = usage.prompt_tokens;
    if (Number.isFinite(usage.completion_tokens)) out.eval_count = usage.completion_tokens;
  }
  return out;
}

/** One Ollama response object from an OpenAI chat.completion body. */
export function openAIBodyToOllama(body, model) {
  const choice = body?.choices?.[0] || {};
  const msg = choice.message || {};
  const message = { role: "assistant", content: typeof msg.content === "string" ? msg.content : "" };
  const thinking = msg.reasoning_content || msg.reasoning;
  if (typeof thinking === "string" && thinking) message.thinking = thinking;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) message.tool_calls = toolCallsOut(msg.tool_calls);
  return { model, created_at: new Date().toISOString(), message, ...finalFields(body?.usage, choice.finish_reason) };
}

const JSON_HEADERS = { "Access-Control-Allow-Origin": "*" };

export async function transformToOllama(response, model) {
  // Errors keep their status and body so the client sees what went wrong.
  if (!response.ok) return response;
  if (!response.body) {
    return new Response("", { status: response.status, headers: { "Content-Type": "application/x-ndjson" } });
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    let out = text;
    try {
      out = JSON.stringify(openAIBodyToOllama(JSON.parse(text), model));
    } catch {}
    return new Response(out, { status: response.status, headers: { "Content-Type": "application/json", ...JSON_HEADERS } });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingToolCalls = {};
  let finishReason = null;
  let usage = null;
  let ended = false;
  const line = (obj) => encoder.encode(JSON.stringify(obj) + "\n");

  // Exactly one done:true line, carrying any tool calls, the finish reason and token counts.
  function end(controller) {
    if (ended) return;
    ended = true;
    const message = { role: "assistant", content: "" };
    const calls = Object.values(pendingToolCalls);
    if (calls.length) message.tool_calls = toolCallsOut(calls);
    controller.enqueue(line({ model, created_at: new Date().toISOString(), message, ...finalFields(usage, finishReason) }));
  }

  function handle(raw, controller) {
    if (ended || !raw.startsWith("data:")) return;
    const data = raw.slice(5).trim();
    if (data === "[DONE]") return end(controller);
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      pendingToolCalls[idx] ??= { id: tc.id, function: { name: "", arguments: "" } };
      if (tc.function?.name) pendingToolCalls[idx].function.name += tc.function.name;
      if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
    }
    const thinking = delta.reasoning_content || delta.reasoning;
    const message = { role: "assistant", content: delta.content || "" };
    if (typeof thinking === "string" && thinking) message.thinking = thinking;
    if (message.content || message.thinking) {
      controller.enqueue(line({ model, created_at: new Date().toISOString(), message, done: false }));
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const raw of lines) handle(raw, controller);
    },
    flush(controller) {
      if (buffer) handle(buffer, controller);
      end(controller);
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    headers: { "Content-Type": "application/x-ndjson", ...JSON_HEADERS },
  });
}
