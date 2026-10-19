import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  await ensureInitialized();
  
  const clonedReq = request.clone();
  let modelName = "llama3.2";
  let chatRequest = request;
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
    // Ollama's /api/chat streams unless `stream: false`; the gateway treats an
    // absent OpenAI `stream` as JSON, so state the Ollama default explicitly.
    if (body && typeof body === "object" && body.stream === undefined) {
      chatRequest = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...body, stream: true }),
      });
    }
  } catch {}

  const response = await handleChat(chatRequest);
  return transformToOllama(response, modelName);
}

