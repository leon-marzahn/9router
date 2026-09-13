import { describe, it, expect } from "vitest";
import { formatRequestDetailContent } from "../../src/shared/utils/requestDetailContent.js";

describe("request detail content display", () => {
  it("renders text and Claude content blocks as readable strings", () => {
    expect(formatRequestDetailContent("The gates open.")).toBe("The gates open.");
    const blocks = [{ type: "text", text: "The gates open." }];
    expect(JSON.parse(formatRequestDetailContent(blocks))).toEqual(blocks);
  });

  it("shows stored truncation previews instead of claiming there is no content", () => {
    const rendered = formatRequestDetailContent({ _truncated: true, _originalSize: 6000, _preview: "The gates open." });
    expect(rendered).toContain("truncated when saved (6000 characters)");
    expect(rendered).toContain("The gates open.");
    expect(rendered).not.toContain("No content");
  });

  it("distinguishes legacy redaction from genuinely missing content", () => {
    expect(formatRequestDetailContent({ redacted: true })).toBe("[Content redacted in this saved log]");
    for (const value of [undefined, null, "", {}, []]) {
      expect(formatRequestDetailContent(value)).toBe("[No content captured]");
    }
  });

  it("preserves structured tool-only responses", () => {
    const response = { content: null, tool_calls: [{ id: "call-1", function: { name: "roll_dice", arguments: "{}" } }] };
    expect(JSON.parse(formatRequestDetailContent(response))).toEqual(response);
  });
});
