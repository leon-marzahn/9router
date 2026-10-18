import { describe, it, expect } from "vitest";
import { pickRegentHeaders, extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("regent headers in request detail", () => {
  it("keeps only x-regent-* / x-9router-* headers", () => {
    const h = pickRegentHeaders({ Authorization: "Bearer x", "X-Regent-Pipeline": "a", "x-9router-token-saver": "off", accept: "*/*" });
    expect(h).toEqual({ "x-regent-pipeline": "a", "x-9router-token-saver": "off" });
  });
  it("adds them to the stored request only when present", () => {
    expect(extractRequestConfig({ messages: [] }, false).regentHeaders).toBeUndefined();
    expect(extractRequestConfig({ messages: [] }, false, { "x-regent-time": "1" }).regentHeaders).toEqual({ "x-regent-time": "1" });
  });
});
