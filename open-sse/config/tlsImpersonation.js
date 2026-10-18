// Per-connection TLS/HTTP2 fingerprint impersonation (wreq-js). Stored on
// providerSpecificData.tlsImpersonation as { browser, os }; absent = off.
// Family aliases resolve to wreq-js's newest profile of that family.
export const TLS_IMPERSONATION_PROFILES = [
  { value: "chrome", label: "Chrome" },
  { value: "edge", label: "Edge" },
  { value: "firefox", label: "Firefox" },
  { value: "safari", label: "Safari" },
  { value: "okhttp", label: "OkHttp" },
];

export const TLS_IMPERSONATION_OSES = [
  { value: "macos", label: "macOS" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux" },
];

const PROFILES = new Set(TLS_IMPERSONATION_PROFILES.map((p) => p.value));
const OSES = new Set(TLS_IMPERSONATION_OSES.map((o) => o.value));

/** Validated { browser, os }, or null when off/invalid. Used on write and on read. */
export function normalizeTlsImpersonation(value) {
  if (!value || typeof value !== "object" || value.enabled === false) return null;
  const browser = PROFILES.has(value.browser) ? value.browser : TLS_IMPERSONATION_PROFILES[0].value;
  const os = OSES.has(value.os) ? value.os : TLS_IMPERSONATION_OSES[0].value;
  return { browser, os };
}
