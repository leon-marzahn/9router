// Per-key pricing: what a customer (an API key) is charged, as opposed to what the
// request cost upstream (the pricing table, calculateCost in usageRepo).
//
//   A price plan = markup (percent over cost) + optional minimum fee per request
//   + optional custom per-model rates (USD per 1M input / output / cached tokens).
//   A custom rate replaces cost-based pricing for that model; every other model
//   gets the markup. The minimum fee applies to any request that used tokens or cost
//   something (so failed, empty requests stay free).
//
//   Plans are named and reusable ("Starter", "Pro"); each key points at one plan or
//   at the default plan ("default"), which is markup 0% (charge = cost) until edited.
//
//   chargeFor(entry)  → called by saveRequestUsage before the row is written, so the
//                       charge is fixed at write time; later plan edits don't rewrite
//                       history. Never throws: on error the charge falls back to cost.
//   getKeySpend(keyId, {from, to}) → totals + per-model breakdown for one key.
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { keyRefForId } from "@/lib/db/helpers/usageKeyRef.js";
import { getApiKeyById, getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo.js";
import { AI_PROVIDERS } from "@/shared/constants/providers.js";
import {
  DEFAULT_PLAN_ID,
  getKeyPlanIds,
  getPricePlans,
  sumKeyUsage,
} from "@/lib/db/repos/pricePlansRepo.js";

export { DEFAULT_PLAN_ID };
export const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIG_TTL_MS = 5_000;
const MAX_RATES = 200;
const MAX_MARKUP = 10_000; // percent
const MAX_FEE = 1_000; // USD per request
const MAX_RATE = 100_000; // USD per 1M tokens

/** Markup 0, no fee, no rates: the customer pays what the request cost. */
export const PASS_THROUGH_PLAN = Object.freeze({
  name: "Default",
  markupPercent: 0,
  minFee: null,
  rates: [],
});

const state = (global._regentBillingState ??= { config: null, configAt: 0 });

/** After plan or assignment writes (and in tests). */
export function invalidateBillingCache() {
  state.config = null;
  state.configAt = 0;
}

async function loadConfig(now = Date.now()) {
  if (state.config && now - state.configAt < CONFIG_TTL_MS) return state.config;
  const [plans, keyPlans, nodes] = await Promise.all([
    getPricePlans(),
    getKeyPlanIds(),
    getProviderNodes(),
  ]);
  const nodePrefixes = {};
  const nodeNames = {};
  for (const n of nodes) {
    if (n?.prefix) nodePrefixes[String(n.prefix).toLowerCase()] = n.id;
    if (n?.id) nodeNames[n.id] = n.name || n.prefix || n.id;
  }
  state.config = { plans, keyPlans, nodePrefixes, nodeNames };
  state.configAt = now;
  return state.config;
}

// ---------- validation ----------

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const badMoney = (v, max) => v !== null && (!Number.isFinite(v) || v < 0 || v > max);

/** Validates a plan from the dashboard. Returns { value } or { error }. */
export function validatePlan(input) {
  if (!input || typeof input !== "object") return { error: "Invalid plan" };
  const name = String(input.name ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 60);
  if (!name) return { error: "Give the plan a name" };
  const markupPercent = num(input.markupPercent) ?? 0;
  if (badMoney(markupPercent, MAX_MARKUP))
    return { error: `Markup must be between 0 and ${MAX_MARKUP}%` };
  let minFee = num(input.minFee);
  if (badMoney(minFee, MAX_FEE)) return { error: `Minimum fee must be between $0 and $${MAX_FEE}` };
  if (minFee === 0) minFee = null;
  const rawRates = Array.isArray(input.rates) ? input.rates : [];
  if (rawRates.length > MAX_RATES) return { error: `Up to ${MAX_RATES} custom rates` };
  const rates = [];
  const seen = new Set();
  for (const r of rawRates) {
    const model = String(r?.model ?? "").trim();
    if (!model || model.length > 200 || /\s/.test(model))
      return { error: "Each custom rate needs a model id (provider/model or model)" };
    const lower = model.toLowerCase();
    if (seen.has(lower)) return { error: `${model} is listed twice` };
    seen.add(lower);
    const input_ = num(r.input);
    const output = num(r.output);
    const cached = num(r.cached);
    if (input_ === null || output === null)
      return { error: `${model}: set input and output prices` };
    for (const v of [input_, output, cached])
      if (badMoney(v, MAX_RATE))
        return { error: `${model}: prices must be $0–$${MAX_RATE} per 1M` };
    rates.push({ model, input: input_, output, cached });
  }
  return { value: { name, markupPercent, minFee, rates } };
}

// ---------- charge ----------

/**
 * Provider id a rate's prefix routes to, written the way clients address models:
 * a provider id ("openai"), an alias ("cc" -> "claude") or a compatible-node prefix
 * ("real" -> "openai-compatible-chat-<uuid>"). Null when the text before the first "/"
 * isn't a known prefix: then the whole string is a bare model id (OpenRouter's
 * "openai/gpt-4o" style ids).
 * @param {string} prefix
 * @param {Record<string, string>} [nodePrefixes] lower-cased node prefix -> node id
 */
export function resolveRatePrefix(prefix, nodePrefixes = {}) {
  const p = String(prefix || "").toLowerCase();
  if (!p) return null;
  if (nodePrefixes[p]) return nodePrefixes[p];
  const id = resolveProviderAlias(p);
  if (id !== p) return id;
  return AI_PROVIDERS[p] ? p : null;
}

/**
 * The custom rate for a request. A rate whose prefix routes to `provider` with the rest
 * equal to `model` wins; otherwise a rate equal to the bare model id. Case-insensitive.
 */
export function findRate(plan, provider, model, nodePrefixes = {}) {
  if (!plan?.rates?.length || !model) return null;
  const m = String(model).toLowerCase();
  const prov = provider ? String(provider).toLowerCase() : null;
  let bare = null;
  for (const r of plan.rates) {
    const id = r.model.toLowerCase();
    const slash = id.indexOf("/");
    if (prov && slash > 0 && id.slice(slash + 1) === m) {
      const target = resolveRatePrefix(id.slice(0, slash), nodePrefixes);
      if (target && target.toLowerCase() === prov) return r;
    }
    if (!bare && id === m) bare = r;
  }
  return bare;
}

const usedTokens = (t = {}) =>
  (t.prompt_tokens || t.input_tokens || 0) + (t.completion_tokens || t.output_tokens || 0) > 0;

/**
 * Pure: what `plan` charges for one request.
 * @param {{ cost?: number, provider?: string, model?: string, tokens?: object }} entry
 */
export function computeCharge(entry, plan = PASS_THROUGH_PLAN, nodePrefixes = {}) {
  const cost = Number(entry.cost) || 0;
  const p = plan || PASS_THROUGH_PLAN;
  const rate = findRate(p, entry.provider, entry.model, nodePrefixes);
  let charge = rate
    ? calculateCostFromTokens(entry.tokens || {}, {
        input: rate.input,
        output: rate.output,
        cached: rate.cached ?? rate.input,
      })
    : cost * (1 + (Number(p.markupPercent) || 0) / 100);
  if (p.minFee > 0 && (cost > 0 || charge > 0 || usedTokens(entry.tokens)))
    charge = Math.max(charge, p.minFee);
  return Number.isFinite(charge) ? charge : cost;
}

function planFor(config, keyId) {
  const id = (keyId && config.keyPlans[keyId]) || DEFAULT_PLAN_ID;
  return config.plans[id] || config.plans[DEFAULT_PLAN_ID] || PASS_THROUGH_PLAN;
}

/** The plan a raw key string is billed on (default plan for unknown / no key). */
export async function planForApiKey(apiKey) {
  const config = await loadConfig();
  const rec = apiKey ? await getApiKeyByKey(apiKey) : null;
  return planFor(config, rec?.id);
}

async function billingContext(apiKey) {
  const config = await loadConfig();
  const rec = apiKey ? await getApiKeyByKey(apiKey) : null;
  return { plan: planFor(config, rec?.id), nodePrefixes: config.nodePrefixes };
}

/**
 * Charge for a usage entry whose `cost` is already set. Requests without an API key
 * (local use) aren't billed to anyone: charge = cost. Never throws.
 */
export async function chargeFor(entry) {
  const cost = Number(entry?.cost) || 0;
  try {
    const apiKey = typeof entry.apiKey === "string" && entry.apiKey ? entry.apiKey : null;
    if (!apiKey) return cost;
    const { plan, nodePrefixes } = await billingContext(apiKey);
    return computeCharge(entry, plan, nodePrefixes);
  } catch (e) {
    console.warn(`[billing] charge fell back to cost: ${e?.message || e}`);
    return cost;
  }
}

// ---------- reporting ----------

/**
 * What one key spent between `from` (inclusive) and `to` (exclusive); defaults to all time.
 * Returns null for an unknown key id. Key strings never leave this function.
 * @returns {Promise<null | { cost: number, charge: number, margin: number, tokens: number,
 *   promptTokens: number, completionTokens: number, requests: number,
 *   byModel: Array<{ provider: string|null, model: string|null, cost: number, charge: number,
 *   tokens: number, promptTokens: number, completionTokens: number, requests: number }> }>}
 */
export async function getKeySpend(keyId, { from, to } = {}) {
  const key = await getApiKeyById(String(keyId));
  if (!key) return null;
  const fromIso = from ? new Date(from).toISOString() : "0000";
  const toIso = to ? new Date(to).toISOString() : "9999";
  const rows = await sumKeyUsage(keyRefForId(key.id), fromIso, toIso);
  const out = {
    cost: 0,
    charge: 0,
    margin: 0,
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requests: 0,
    byModel: [],
  };
  for (const r of rows) {
    const m = {
      provider: r.provider ?? null,
      model: r.model ?? null,
      cost: Number(r.cost) || 0,
      charge: Number(r.charge) || 0,
      promptTokens: Number(r.promptTokens) || 0,
      completionTokens: Number(r.completionTokens) || 0,
      requests: Number(r.requests) || 0,
    };
    m.tokens = m.promptTokens + m.completionTokens;
    out.byModel.push(m);
    for (const f of ["cost", "charge", "tokens", "promptTokens", "completionTokens", "requests"])
      out[f] += m[f];
  }
  out.margin = out.charge - out.cost;
  return out;
}

/** A routed prefix's provider name ("Fake", "Claude Code"); null for a bare model id. */
function describeRateModel(model, nodePrefixes, nodeNames) {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const id = resolveRatePrefix(model.slice(0, slash), nodePrefixes);
  if (!id) return null;
  return nodeNames[id] || AI_PROVIDERS[id]?.name || id;
}

/** Plans for the dashboard: { plans: {id: plan}, keyPlans: {keyId: planId} }, default always present. */
export async function listPlans() {
  invalidateBillingCache();
  const { plans, keyPlans, nodePrefixes, nodeNames } = await loadConfig();
  const all = { [DEFAULT_PLAN_ID]: PASS_THROUGH_PLAN, ...plans };
  // How each rate's model text resolves, for the editor: a provider name, or null (bare model id).
  const resolved = {};
  for (const p of Object.values(all)) {
    for (const r of p.rates || [])
      resolved[r.model] = describeRateModel(r.model, nodePrefixes, nodeNames);
  }
  return {
    resolved,
    plans: all,
    keyPlans,
  };
}
