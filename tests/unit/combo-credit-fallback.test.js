import { describe, expect, it, vi } from "vite-plus/test";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("combo credit fallback", () => {
  // Credit exhaustion is account-scoped (the account cools down); a plain bad request is
  // request-scoped (no cooldown). Since 5cdcddf5 both advance the combo to the next model.
  it.each([
    ["You have insufficient credits to make this request.", true],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", true],
    ["Bad request", false],
  ])("routes a 400 response correctly: %s", async (message, accountScoped) => {
    const verdict = checkFallbackError(400, message, 0, "cmc");
    expect(verdict.shouldFallback).toBe(accountScoped);
    expect(verdict.requestScoped === true).toBe(!accountScoped);

    const body = { messages: [{ role: "user", content: "Hello" }] };
    const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"];
    const failure = Response.json({ error: { message } }, { status: 400 });
    const success = Response.json({ choices: [{ message: { content: "Hello" } }] });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);

    const response = await handleComboChat({
      body, models, handleSingleModel,
      log: { info: vi.fn(), warn: vi.fn() },
      comboName: "credit-fallback", comboStrategy: "fallback",
    });

    expect(response).toBe(success);
    expect(handleSingleModel.mock.calls).toEqual(models.map((model) => [body, model]));
  });
});
