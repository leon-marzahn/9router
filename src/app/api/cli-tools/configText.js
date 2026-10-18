// Quoting for values we splice into hand-edited TOML / YAML / dotenv files. Model ids,
// URLs and profile values come from the dashboard request body, so a quote or newline in
// one must never be able to add keys or sections of its own.

// C0 controls (tab included), DEL and the C1 range. No config value we write needs them.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export class ConfigValueError extends Error {
  constructor(label, message) {
    super(message || `${label || "Value"} must not contain control characters or line breaks`);
    this.name = "ConfigValueError";
    this.status = 400;
  }
}

export function assertConfigValue(value, label) {
  const s = String(value ?? "");
  if (CONTROL_CHARS.test(s)) throw new ConfigValueError(label);
  return s;
}

// TOML basic string. JSON string escaping is a subset of TOML's (\" \\ \uXXXX), and
// control characters are rejected before they reach it.
export const tomlString = (value, label) => JSON.stringify(assertConfigValue(value, label));

// YAML double-quoted scalar; JSON strings are valid YAML double-quoted scalars.
export const yamlString = (value, label) => JSON.stringify(assertConfigValue(value, label));

// dotenv `KEY="value"`: escape backslashes and quotes, no line breaks.
export const dotenvString = (value, label) =>
  `"${assertConfigValue(value, label).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// For a route's catch block: hostile input is a 400, not a 500.
export const configErrorStatus = (error) => (error instanceof ConfigValueError ? 400 : 500);
