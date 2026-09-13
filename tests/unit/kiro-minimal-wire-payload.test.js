import { describe, expect, it } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

for (const [name, translate, body] of [
  ["OpenAI", openaiToKiroRequest, { messages: [{ role: "user", content: "hello" }] }],
  ["Claude", claudeToKiroRequest, { messages: [{ role: "user", content: "hello" }] }],
]) {
  describe(`${name} Kiro minimal wire payload`, () => {
    it.each([
      "kiro/claude-sonnet-4.5",
      "kiro/claude-sonnet-4.5-thinking",
      "kiro/claude-sonnet-4.5-thinking-agentic",
    ])("omits unsupported wire fields for %s", (model) => {
      const payload = translate(model, body, true, {});
      expect(payload).not.toHaveProperty("systemPrompt");
      expect(payload).not.toHaveProperty("agentMode");
      expect(payload.conversationState).not.toHaveProperty("agentContinuationId");
      expect(payload.conversationState).not.toHaveProperty("agentTaskType");
      expect(payload.conversationState.chatTriggerType).toBe("MANUAL");
      expect(payload.conversationState.conversationId).toEqual(expect.any(String));
      expect(payload.conversationState.conversationId.length).toBeGreaterThan(0);
      expect(payload.conversationState.currentMessage.userInputMessage).not.toHaveProperty("systemInstruction");
      expect(payload.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR");
    });
  });
}
