// /v1/api/chat (Ollama shim): Ollama streams unless `stream: false`, while the
// gateway treats an absent OpenAI `stream` as JSON, so the route must state it.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { handleChat } = vi.hoisted(() => ({ handleChat: vi.fn(async () => new Response("data: [DONE]\n\n")) }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));
vi.mock("open-sse/utils/ollamaTransform.js", () => ({ transformToOllama: vi.fn((res) => res) }));

const { POST } = await import("../../src/app/api/v1/api/chat/route.js");

const post = (body) => POST(new Request("http://localhost/v1/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-x" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const forwarded = async () => handleChat.mock.calls.at(-1)[0];

beforeEach(() => handleChat.mockClear());

describe("Ollama /api/chat stream default", () => {
  it("adds stream:true when the client omitted it, keeping headers", async () => {
    await post({ model: "llama3.2", messages: [] });
    const req = await forwarded();
    expect((await req.json()).stream).toBe(true);
    expect(req.headers.get("authorization")).toBe("Bearer sk-x");
  });

  it("leaves an explicit stream value alone", async () => {
    await post({ model: "llama3.2", messages: [], stream: false });
    expect((await (await forwarded()).json()).stream).toBe(false);
  });

  it("passes an unparseable body through untouched", async () => {
    await post("{nope");
    expect(await (await forwarded()).text()).toBe("{nope");
  });
});
