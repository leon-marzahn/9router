import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  REDACTED,
  redactHeaders,
  redactUrl,
  translatorDisabledResponse,
} from "../../src/lib/translatorDebug.js";

describe("translator debug helpers", () => {
  const prev = process.env.ENABLE_TRANSLATOR;
  afterEach(() => {
    if (prev === undefined) delete process.env.ENABLE_TRANSLATOR;
    else process.env.ENABLE_TRANSLATOR = prev;
  });

  it("refuses requests unless ENABLE_TRANSLATOR is true", async () => {
    delete process.env.ENABLE_TRANSLATOR;
    const res = translatorDisabledResponse();
    expect(res.status).toBe(404);
    process.env.ENABLE_TRANSLATOR = "true";
    expect(translatorDisabledResponse()).toBeNull();
  });

  it("hides credential headers but keeps the rest", () => {
    const out = redactHeaders({
      Authorization: "Bearer sk-live",
      "x-api-key": "k",
      "x-goog-api-key": "g",
      Cookie: "c",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(out).toEqual({
      Authorization: REDACTED,
      "x-api-key": REDACTED,
      "x-goog-api-key": REDACTED,
      Cookie: REDACTED,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(redactHeaders(null)).toEqual({});
  });

  it("hides API keys in the query string", () => {
    const url = redactUrl("https://g.example/v1/models/x:stream?alt=sse&key=AIzaSECRET");
    expect(url).not.toContain("SECRET");
    expect(url).toContain("alt=sse");
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
