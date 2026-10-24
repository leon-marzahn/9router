// Per-connection proxy scope.
//
// Upstream calls get their connection's proxy passed explicitly to
// proxyAwareFetch. Everything else a connection triggers (OAuth token refresh,
// quota/usage lookups, model lists, connection tests, non-chat upstream calls)
// used to call the global fetch, which only knows the global outbound proxy,
// so those requests left over the direct IP even when the connection was set
// to use a proxy.
//
// runWithProxyOptions() makes a connection's proxy options the default for
// every fetch started inside `fn`: proxyAwareFetch called without options and
// the patched global fetch both pick it up. Explicit proxyOptions still win,
// and a caller's own dispatcher is never replaced.
//
// Keep scopes narrow. Anything started inside one inherits it, including
// fire-and-forget work, timers and lazily shared promises. App-level side
// effects (usage rows, budgets, notifications) must run outside: use
// runOutsideProxyScope, or runCoreInProxyScope, which runs a handler's
// callbacks outside the scope.
import { AsyncLocalStorage } from "node:async_hooks";

// One store per process: Next can bundle this module more than once, and the
// copy that runs the scope must be the one the patched global fetch reads.
const STORE_KEY = Symbol.for("regent.proxyScope");
const store = globalThis[STORE_KEY] || (globalThis[STORE_KEY] = new AsyncLocalStorage());

/** Error code of a request refused because the connection's proxy failed. */
export const PROXY_UNAVAILABLE = "PROXY_UNAVAILABLE";

/** providerSpecificData keys getProviderCredentials fills with the resolved proxy. */
export const RESOLVED_PROXY_KEYS = [
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "connectionProxyPoolId",
  "vercelRelayUrl",
  "strictProxy",
];

/**
 * Run `fn` with `proxyOptions` as the default proxy for fetches it starts.
 * With no options, `fn` runs in whatever scope is already active.
 */
export function runWithProxyOptions(proxyOptions, fn) {
  if (!proxyOptions) return fn();
  return store.run(proxyOptions, fn);
}

/** Run `fn` outside any proxy scope (app-level side effects). */
export function runOutsideProxyScope(fn) {
  return store.exit(fn);
}

/** The proxy options of the active scope, or null outside one. */
export function getScopedProxyOptions() {
  return store.getStore() || null;
}

/**
 * proxyAwareFetch options from a resolveConnectionProxyConfig() result, with
 * the same fields and strict semantics as the upstream request path: a strict
 * pool fails instead of going direct, a non-strict proxy falls back.
 */
export function proxyOptionsFromConfig(cfg) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    proxyPoolId: cfg?.proxyPoolId || null,
    strictProxy: cfg?.strictProxy === true,
  };
}

/**
 * proxyAwareFetch options from credentials whose providerSpecificData already
 * holds the resolved proxy (getProviderCredentials writes it there). TLS
 * impersonation is left out: it is an upstream-call setting, not routing.
 */
export function proxyOptionsFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return proxyOptionsFromConfig({ ...psd, proxyPoolId: psd.connectionProxyPoolId });
}

/**
 * Proxy options for a token refresh. A non-strict proxy may still fall back to
 * a direct connection, but only when the proxy failed before the request could
 * have been sent: replaying a refresh whose rotated token was already spent
 * revokes the whole token family.
 */
export function refreshProxyOptions(proxyOptions, onProxyUnavailable = null) {
  if (!proxyOptions) return null;
  return {
    ...proxyOptions,
    tlsImpersonation: null,
    directFallback: "connect-only",
    ...(onProxyUnavailable ? { onProxyUnavailable } : {}),
  };
}

/**
 * Run an executor's token refresh in the connection's proxy scope. Use this
 * instead of calling executor.refreshCredentials directly: overrides that call
 * the global fetch, or ignore proxyOptions, still leave through the proxy.
 * When the refresh fails because the proxy is unavailable, the proxy error is
 * thrown (code PROXY_UNAVAILABLE) so callers don't report an expired sign-in.
 */
export async function refreshCredentialsWithProxy(executor, credentials, log, proxyOptions = null) {
  let proxyError = null;
  const options = refreshProxyOptions(proxyOptions, (err) => {
    proxyError ||= err;
  });
  const result = await runWithProxyOptions(options, () =>
    executor.refreshCredentials(credentials, log, options),
  );
  if (!result && proxyError) throw proxyError;
  return result;
}

/**
 * Run a handler core in the connection's proxy scope (from its credentials).
 * Function-valued arguments (onUsage, onRequestSuccess, onCredentialsRefreshed,
 * …) are app-level callbacks: they run outside the scope, so usage saving,
 * budgets and notifications never use the connection's proxy.
 */
export function runCoreInProxyScope(args, core) {
  const proxyOptions = proxyOptionsFromCredentials(args?.credentials);
  return runWithProxyOptions(proxyOptions, () => core(callbacksOutsideScope(args)));
}

function callbacksOutsideScope(args) {
  if (!args || typeof args !== "object") return args;
  const out = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "function") out[key] = (...a) => store.exit(() => value(...a));
  }
  return out;
}
