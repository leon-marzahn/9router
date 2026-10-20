// Spend budgets per API key (a customer) and for all traffic together.
//
//   checkBudget(apiKey)    → null, or { scope, resetsAt } when a hard-stopped budget is used up.
//                            Runs on every /v1 request: reads in-memory counters only
//                            (seeded from one indexed SUM per scope, refreshed every
//                            COUNTER_REFRESH_MS). On an internal error it FAILS CLOSED for
//                            budgets with a hard stop (the request is refused) and open for
//                            the rest; the error is logged either way.
//   recordUsage(entry)     → called after a usage row is written; bumps the counters and
//                            sends threshold alerts (once per scope, period and threshold,
//                            persisted in budgetAlerts so restarts don't re-send).
//
// Spend: a key's budget counts what its customer is charged (src/lib/billing: cost
// plus the key's price plan); the global budget counts upstream cost, i.e. what the
// operator pays providers. Token and request limits are the same either way.
//
// Periods are UTC calendar days / months.
// A request that starts under the limit is never cut off, so spend can overshoot
// by whatever is in flight when the limit is reached.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import {
  GLOBAL_SCOPE,
  claimAlert,
  getBudgets,
  keyScope,
  sumUsageSince,
  zeroCostModelsSince,
} from "@/lib/db/repos/budgetsRepo.js";
import { keyRefForId } from "@/lib/db/helpers/usageKeyRef.js";
import { isEmail } from "@/lib/notify/config.js";

export { GLOBAL_SCOPE, keyScope };
export const PERIODS = ["day", "month"];
export const COUNTER_REFRESH_MS = 60_000;

/** "charge" for a key's budget (what the customer pays), "cost" for the global one. */
export const spendBasis = (scope) => (scope === GLOBAL_SCOPE ? "cost" : "charge");
const CONFIG_TTL_MS = 5_000;
const MAX_WARN = 3;

const state = (global._regentBudgetState ??= {
  config: null,
  configAt: 0,
  lastGood: null,
  keyIds: new Map(),
  counters: new Map(),
});
state.keyIds ??= new Map(); // a state object from before a hot reload

/** Test hook / after config writes. */
export function invalidateBudgetCache({ counters = false } = {}) {
  state.config = null;
  state.configAt = 0;
  if (counters) state.counters.clear();
}

// ---------- config ----------

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Validates a budget from the dashboard. Returns { value } or { error }. */
export function validateBudget(input, { isKey = true } = {}) {
  if (!input || typeof input !== "object") return { error: "Invalid budget" };
  const period = input.period ?? "month";
  if (!PERIODS.includes(period)) return { error: "Period must be day or month" };
  const spendLimit = num(input.spendLimit);
  const tokenLimit = num(input.tokenLimit);
  const requestLimit = num(input.requestLimit);
  if (spendLimit !== null && (!Number.isFinite(spendLimit) || spendLimit <= 0 || spendLimit > 1e9))
    return { error: "Spend limit must be a positive amount" };
  for (const [name, v] of [
    ["Token", tokenLimit],
    ["Request", requestLimit],
  ]) {
    if (v !== null && (!Number.isInteger(v) || v <= 0 || v > 1e15))
      return { error: `${name} limit must be a positive whole number` };
  }
  if (spendLimit === null && tokenLimit === null && requestLimit === null)
    return { error: "Set at least one limit" };
  const rawWarn = Array.isArray(input.warnAt) ? input.warnAt : [];
  const warnAt = [...new Set(rawWarn.map(Number))].sort((a, b) => a - b);
  if (warnAt.length > MAX_WARN || warnAt.some((p) => !Number.isInteger(p) || p < 1 || p > 99))
    return { error: `Up to ${MAX_WARN} warning thresholds between 1 and 99%` };
  const contactEmail = String(input.contactEmail ?? "").trim();
  if (contactEmail && (!isKey || !isEmail(contactEmail)))
    return {
      error: isKey
        ? "Contact email isn't a valid address"
        : "No contact email on the global budget",
    };
  return {
    value: {
      enabled: input.enabled !== false,
      period,
      spendLimit,
      tokenLimit,
      requestLimit,
      warnAt,
      hardStop: input.hardStop === true,
      contactEmail,
    },
  };
}

async function loadConfig(now = Date.now()) {
  if (state.config && now - state.configAt < CONFIG_TTL_MS) return state.config;
  state.config = await getBudgets();
  state.configAt = now;
  state.lastGood = state.config;
  return state.config;
}

// ---------- periods ----------

/** UTC calendar day or month containing `now`. */
export function periodBounds(period, now = new Date()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start =
    period === "day" ? new Date(Date.UTC(y, m, d.getUTCDate())) : new Date(Date.UTC(y, m, 1));
  const end =
    period === "day"
      ? new Date(Date.UTC(y, m, d.getUTCDate() + 1))
      : new Date(Date.UTC(y, m + 1, 1));
  const iso = start.toISOString();
  const key = period === "day" ? `d:${iso.slice(0, 10)}` : `m:${iso.slice(0, 7)}`;
  return { start, end, key };
}

// ---------- counters ----------

/** Usage rows store key references: "key:<id>" → "id:<id>"; the global scope → null (all rows). */
const usageRefFor = (scope) =>
  scope === GLOBAL_SCOPE ? null : keyRefForId(scope.slice("key:".length));

async function getUsage(scope, period, now = new Date()) {
  const { start, key } = periodBounds(period, now);
  const c = state.counters.get(scope);
  if (c && c.periodKey === key && now.getTime() - c.loadedAt < COUNTER_REFRESH_MS) return c;
  const sum = await sumUsageSince(usageRefFor(scope), start.toISOString());
  const spend = spendBasis(scope) === "cost" ? sum.cost : sum.charge;
  const next = { periodKey: key, loadedAt: now.getTime(), ...sum, spend };
  state.counters.set(scope, next);
  return next;
}

/** `usage.spend` is cost or charge depending on the scope (see spendBasis). */
export function usageRatio(budget, usage) {
  let ratio = 0;
  const spend = usage.spend ?? usage.cost;
  if (budget.spendLimit) ratio = Math.max(ratio, spend / budget.spendLimit);
  if (budget.tokenLimit) ratio = Math.max(ratio, usage.tokens / budget.tokenLimit);
  if (budget.requestLimit) ratio = Math.max(ratio, usage.requests / budget.requestLimit);
  return ratio;
}

/** Scopes that apply to a request made with `apiKey` (raw key string or null). */
async function scopesFor(apiKey, budgets) {
  const out = [];
  if (apiKey && Object.keys(budgets).some((s) => s.startsWith("key:"))) {
    const rec = await getApiKeyByKey(apiKey);
    if (rec) state.keyIds.set(apiKey, rec.id);
    if (state.keyIds.size > 10_000) state.keyIds.clear();
    const scope = rec ? keyScope(rec.id) : null;
    if (scope && budgets[scope]?.enabled) out.push({ scope, key: rec });
  }
  if (budgets[GLOBAL_SCOPE]?.enabled) out.push({ scope: GLOBAL_SCOPE, key: null });
  return out;
}

// ---------- enforcement ----------

const refusal = (scope, budget, now) => ({
  scope,
  global: scope === GLOBAL_SCOPE,
  resetsAt: periodBounds(budget.period, now).end.toISOString(),
});

function firstHardStop(budgets, scopes) {
  for (const s of scopes) if (budgets[s]?.enabled && budgets[s]?.hardStop) return s;
  return null;
}

/**
 * Null when the request may proceed.
 * Internal errors: refuse when a hard-stopped budget applies (fail-closed), allow otherwise.
 * @returns {Promise<null | { scope: string, global: boolean, resetsAt: string }>}
 */
export async function checkBudget(apiKey, { now = new Date() } = {}) {
  try {
    const budgets = await loadConfig(now.getTime());
    if (!budgets || !Object.keys(budgets).length) return null;
    for (const s of await scopesFor(apiKey, budgets)) {
      const b = budgets[s.scope];
      if (!b.hardStop) continue;
      const usage = await getUsage(s.scope, b.period, now);
      if (usageRatio(b, usage) >= 1) return refusal(s.scope, b, now);
    }
    return null;
  } catch (e) {
    return failClosed(apiKey, now, e);
  }
}

/**
 * The check broke. Using only what's cached (the last config that loaded and the
 * key ids seen before), refuse if a hard-stopped budget applies to this request;
 * otherwise let it through. Never throws.
 */
function failClosed(apiKey, now, error) {
  try {
    const budgets = state.lastGood;
    const id = apiKey ? state.keyIds.get(apiKey) : null;
    const scope = budgets
      ? firstHardStop(budgets, [id ? keyScope(id) : null, GLOBAL_SCOPE].filter(Boolean))
      : null;
    console.warn(
      `[budget] check failed (${error?.message || error}); ${scope ? "refusing: a hard stop applies" : "letting the request through"}`,
    );
    return scope ? refusal(scope, budgets[scope], now) : null;
  } catch {
    return null;
  }
}

// ---------- recording + alerts ----------

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function describeUsage(b, u) {
  const parts = [];
  if (b.spendLimit) parts.push(`${money(u.spend ?? u.cost)} of ${money(b.spendLimit)}`);
  if (b.tokenLimit)
    parts.push(
      `${u.tokens.toLocaleString("en-US")} of ${b.tokenLimit.toLocaleString("en-US")} tokens`,
    );
  if (b.requestLimit)
    parts.push(
      `${u.requests.toLocaleString("en-US")} of ${b.requestLimit.toLocaleString("en-US")} requests`,
    );
  return parts.join(", ");
}

/** Subject + text for one alert. Customer mail names only their own key. */
export function alertMessage({ scope, budget, usage, threshold, keyName, resetsAt }) {
  const who = scope === GLOBAL_SCOPE ? "All API keys" : `API key "${keyName}"`;
  const period = budget.period === "day" ? "today" : "this month";
  const reached = threshold >= 100;
  const subject = reached
    ? `${who}: budget reached for ${period}`
    : `${who}: ${threshold}% of budget used ${period}`;
  const blocked = reached && budget.hardStop;
  const text = [
    `${who} has used ${describeUsage(budget, usage)} ${period}.`,
    reached
      ? blocked
        ? "New requests are refused until the budget resets."
        : "Requests still go through (no hard stop is set)."
      : `You'll get another email if usage reaches ${budget.hardStop ? "the hard stop" : "the limit"}.`,
    `The budget resets at ${new Date(resetsAt).toUTCString()}.`,
  ].join("\n\n");
  return { subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), text };
}

async function sendAlerts({ scope, budget, usage, key, now }) {
  const ratio = usageRatio(budget, usage);
  const pct = ratio * 100;
  const thresholds = [...new Set([...(budget.warnAt || []), 100])].filter((t) => pct >= t);
  if (!thresholds.length) return;
  const { key: periodKey, end } = periodBounds(budget.period, now);
  const claimed = [];
  for (const t of thresholds) if (await claimAlert(scope, periodKey, t)) claimed.push(t);
  if (!claimed.length) return;
  const threshold = Math.max(...claimed);

  const [{ notify }, { getSettings }] = await Promise.all([
    import("@/lib/notify/index.js"),
    import("@/lib/db/index.js"),
  ]);
  const settings = await getSettings();
  const msg = alertMessage({
    scope,
    budget,
    usage,
    threshold,
    keyName: key?.name || key?.id || "",
    resetsAt: end.toISOString(),
  });
  const recipients = new Set();
  if (isEmail(settings.notifyAdminEmail)) recipients.add(settings.notifyAdminEmail);
  if (scope !== GLOBAL_SCOPE && isEmail(budget.contactEmail)) recipients.add(budget.contactEmail);
  // One email per recipient, so a customer never sees the admin's address.
  for (const to of recipients) {
    await notify(
      { to, ...msg, dedupeKey: `budget:${scope}:${periodKey}:${threshold}:${to}` },
      { settings },
    );
  }
}

/**
 * After a usage row is stored. Never throws.
 * @param {{ apiKey?: string|null, cost?: number, tokens?: object, timestamp?: string }} entry
 */
export async function recordUsage(entry, { now = new Date() } = {}) {
  try {
    const budgets = await loadConfig(now.getTime());
    if (!budgets || !Object.keys(budgets).length) return;
    const t = entry.tokens || {};
    const cost = Number(entry.cost) || 0;
    const inc = {
      cost,
      charge: Number(entry.charge ?? cost) || 0,
      tokens:
        (t.prompt_tokens || t.input_tokens || 0) + (t.completion_tokens || t.output_tokens || 0),
    };
    const apiKey = typeof entry.apiKey === "string" && entry.apiKey ? entry.apiKey : null;
    for (const s of await scopesFor(apiKey, budgets)) {
      const b = budgets[s.scope];
      const { key: periodKey } = periodBounds(b.period, now);
      const c = state.counters.get(s.scope);
      let usage;
      if (c && c.periodKey === periodKey && now.getTime() - c.loadedAt < COUNTER_REFRESH_MS) {
        c.cost += inc.cost;
        c.charge = (c.charge || 0) + inc.charge;
        c.spend = (c.spend || 0) + (spendBasis(s.scope) === "cost" ? inc.cost : inc.charge);
        c.tokens += inc.tokens;
        c.requests += 1;
        usage = c;
      } else {
        // Fresh load: the row is already in the table, so it's counted.
        usage = await getUsage(s.scope, b.period, now);
      }
      await sendAlerts({ scope: s.scope, budget: b, usage, key: s.key, now });
    }
  } catch (e) {
    console.warn(`[budget] usage not recorded: ${e?.message || e}`);
  }
}

// ---------- dashboard ----------

/**
 * Current period status for one scope ("global" or keyScope(id)).
 * `spend` is what the spend limit is measured against: `charge` (customer price) for a
 * key, `cost` (upstream) for global; `spendBasis` says which. Both are always reported.
 */
export async function budgetStatus(scope, budget, { now = new Date() } = {}) {
  const usage = await getUsage(scope, budget.period, now);
  const ratio = usageRatio(budget, usage);
  const warn = (budget.warnAt || [])[0];
  const { start, end } = periodBounds(budget.period, now);
  return {
    periodStart: start.toISOString(),
    resetsAt: end.toISOString(),
    cost: usage.cost,
    charge: usage.charge ?? usage.cost,
    spend: usage.spend ?? usage.cost,
    spendBasis: spendBasis(scope),
    tokens: usage.tokens,
    requests: usage.requests,
    ratio,
    state: ratio >= 1 ? "over" : warn && ratio * 100 >= warn ? "warning" : "ok",
    blocked: budget.enabled && budget.hardStop && ratio >= 1,
    unpricedModels: budget.spendLimit
      ? await unpricedModels(usageRefFor(scope), start, spendBasis(scope))
      : [],
  };
}

/**
 * "provider/model" used this period with no price configured: a spend limit
 * doesn't see them. (Zero-cost rows whose model does have a price are free models.)
 */
async function unpricedModels(keyRef, start, basis) {
  try {
    const { getPricingForModel } = await import("@/lib/db/repos/pricingRepo.js");
    const { providerName } = await import("@/lib/providerName.js");
    const out = [];
    const names = new Map();
    for (const r of await zeroCostModelsSince(keyRef, start.toISOString(), { basis })) {
      if (await getPricingForModel(r.provider, r.model)) continue;
      // Custom nodes show their prefix (or name), never the internal openai-compatible-…-<uuid> id.
      out.push(`${await providerName(r.provider, names, { prefix: true })}/${r.model}`);
    }
    return out;
  } catch {
    return [];
  }
}
