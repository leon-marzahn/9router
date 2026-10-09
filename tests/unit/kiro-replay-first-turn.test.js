// A first-turn request has no history: its only message is the session start. Sending it again
// under the same session id (client retry, regenerate, or a reused id) must not replay the stored
// start on top of it, or the first message goes upstream twice and the prompt roughly doubles.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { clearKiroSessionReplayStore } from "../../open-sse/utils/kiroSessionReplay.js";

const body = (user) => ({ messages: [{ role: "system", content: "Be terse." }, { role: "user", content: user }] });
const send = (b, sessionId = "first-turn-repeat") =>
  openaiToKiroRequest("claude-sonnet-4.6", b, true, {
    connectionId: "kiro-first-turn-test",
    rawHeaders: { "x-session-id": sessionId, "x-9router-kiro-time": "off" },
  });
const countOf = (payload, text) =>
  JSON.stringify(payload.conversationState).split(text).length - 1;

describe("Kiro session replay on a repeated first turn", () => {
  beforeEach(() => clearKiroSessionReplayStore());
  afterEach(() => clearKiroSessionReplayStore());

  it("sends the first message once, both times", () => {
    const first = send(body("Say ok."));
    const repeat = send(body("Say ok."));
    expect(countOf(first, "Say ok.")).toBe(1);
    expect(countOf(repeat, "Say ok.")).toBe(1);
    expect(repeat.conversationState.history).toEqual([]);
  });

  it("does not leak the old first message into a new conversation reusing the id", () => {
    send(body("Old topic."));
    const reused = send(body("New topic."));
    expect(countOf(reused, "Old topic.")).toBe(0);
    expect(countOf(reused, "New topic.")).toBe(1);
  });

  it("still replays the frozen first message on later turns", () => {
    send(body("Say ok."));
    const turn2 = send({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Say ok." },
        { role: "assistant", content: "ok" },
        { role: "user", content: "Again." },
      ],
    });
    expect(turn2.conversationState.history.length).toBe(2);
    expect(countOf(turn2, "Say ok.")).toBe(1);
  });
});
