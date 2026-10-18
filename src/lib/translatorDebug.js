// Server-side helpers for the Translator debug tool (/dashboard/translator).

/** The tool's API routes only exist when the operator turned the tool on. */
export function translatorDisabledResponse() {
  if (process.env.ENABLE_TRANSLATOR === "true") return null;
  return Response.json(
    {
      success: false,
      error: "The translator debug tool is turned off (set ENABLE_TRANSLATOR=true).",
    },
    { status: 404 },
  );
}

const SECRET_HEADER = /authorization|api-key|apikey|cookie|token|secret|signature|x-goog-api-key/i;
const SECRET_PARAM = /^(key|api_key|apikey|access_token|token|sig|signature)$/i;
export const REDACTED = "[hidden]";

/** Built upstream headers carry the account's credentials; the browser only needs to see that they're set. */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SECRET_HEADER.test(k) ? REDACTED : v]),
  );
}

/** Some providers (Gemini) put the API key in the query string. */
export function redactUrl(url) {
  if (typeof url !== "string") return url;
  try {
    const u = new URL(url);
    const secret = [...new Set(u.searchParams.keys())].filter((k) => SECRET_PARAM.test(k));
    for (const k of secret) u.searchParams.set(k, REDACTED);
    return u.toString();
  } catch {
    return url;
  }
}
