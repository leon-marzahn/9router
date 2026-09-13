/** Format stored log payloads, including structured responses and storage limits. */
export function formatRequestDetailContent(value) {
  if (value?.redacted === true) return "[Content redacted in this saved log]";
  if (value?._truncated === true) {
    return `[Content truncated when saved (${value._originalSize} characters). Only this preview is available.]\n\n${value._preview || ""}`;
  }
  if (value == null || value === "") return "[No content captured]";
  if (typeof value === "string") return value;
  if (typeof value === "object" && Object.keys(value).length === 0) return "[No content captured]";
  return JSON.stringify(value, null, 2);
}
