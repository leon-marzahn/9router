// Customer view: a key holder reads their own usage, spend and budget with the same
// API key they use for /v1. No dashboard session is involved.
//
// Security contract (see tests/unit/customer-view.test.js):
//   - Off unless Settings → Customer view is on; a key can be excluded per key.
//   - The key is matched in constant time against every stored key (no early exit).
//   - Every query below is scoped by the matched key's own string: one key can never
//     read another key's rows.
//   - Responses never carry the resolved upstream model (only the requested name), the key, provider, account/connection, endpoint, routing
//     trace, or prompt/response bodies.
//   - Spend is the per-row `charge` column when it exists (per-key pricing), `cost`
//     otherwise. Budget status only supplies the budget card's ratio/state.
import crypto from "node:crypto";
import { keyRefForId } from "@/lib/db/helpers/usageKeyRef.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getBudget } from "@/lib/db/repos/budgetsRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { budgetStatus, keyScope, periodBounds } from "@/lib/budgets/index.js";

export const CHART_DAYS = 30;
export const RECENT_LIMIT = 50;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

/** The stored key record equal to `presented`, compared in constant time; null otherwise. */
export function matchKey(presented, keys) {
  if (typeof presented !== "string" || !presented || presented.length > 512) return null;
  const want = digest(presented);
  let found = null;
  for (const k of keys) {
    if (!k?.key) continue;
    // Compare every key so timing doesn't reveal where (or whether) a match sits.
    if (crypto.timingSafeEqual(want, digest(k.key)) && !found) found = k;
  }
  return found;
}

/** Bearer token only: no query string (it would land in logs/history), no other headers. */
export function bearerFrom(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

export function customerViewSettings(settings) {
  return {
    enabled: settings?.customerViewEnabled === true,
    blocked: Array.isArray(settings?.customerViewBlockedKeys)
      ? settings.customerViewBlockedKeys.filter((x) => typeof x === "string")
      : [],
  };
}

/** Validates the settings patch fields. Returns { value } or { error }. */
export function validateCustomerViewPatch(body) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(body, "customerViewEnabled")) {
    if (typeof body.customerViewEnabled !== "boolean")
      return { error: "customerViewEnabled must be true or false" };
    out.customerViewEnabled = body.customerViewEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(body, "customerViewBlockedKeys")) {
    const v = body.customerViewBlockedKeys;
    if (
      !Array.isArray(v) ||
      v.length > 10_000 ||
      v.some((x) => typeof x !== "string" || x.length > 100)
    )
      return { error: "customerViewBlockedKeys must be a list of key ids" };
    out.customerViewBlockedKeys = [...new Set(v)];
  }
  return { value: out };
}

/**
 * The key record allowed to use the customer view, or null (feature off, unknown,
 * inactive or excluded key). Callers answer every null the same way.
 */
export async function resolveCustomerKey(presented) {
  if (!presented) return null;
  const cfg = customerViewSettings(await getSettings());
  if (!cfg.enabled) return null;
  const rec = matchKey(presented, await getApiKeys());
  if (!rec || !rec.isActive || cfg.blocked.includes(rec.id)) return null;
  return rec;
}

// ---------- data ----------

let chargeColumn = null;
function spendExpr(db) {
  if (chargeColumn === null) {
    try {
      chargeColumn = db.all(`PRAGMA table_info(usageHistory)`).some((c) => c.name === "charge");
    } catch {
      chargeColumn = false;
    }
  }
  // usageHistory.charge comes from per-key pricing (migration 004, which backfills
  // charge = cost for older rows). Spend is charge only: a NULL charge counts as 0 and
  // never falls back to the raw upstream cost. Without the column, cost is the charge.
  return chargeColumn ? "COALESCE(charge, 0)" : "COALESCE(cost, 0)";
}
/** Test hook: re-detect the charge column. */
export function resetSchemaCache() {
  chargeColumn = null;
}

const n = (v) => Number(v) || 0;

// Customers see the model name they asked for (a combo or alias name), never the
// upstream model it resolved to. `usageHistory.model` is the resolved one, so it is
// never selected here. Rows saved before requestedModel was recorded show UNKNOWN_MODEL.
const REQUESTED = "json_extract(meta, '$.requestedModel')";
export const UNKNOWN_MODEL = "Unknown model";

/** "ok", "error", or a 3-digit HTTP code: never the stored free text (it can hold upstream URLs). */
export function publicStatus(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "" || s === "ok" || s === "success") return "ok";
  const code = /\b([1-5]\d\d)\b/.exec(s);
  if (code) return code[1].startsWith("2") ? "ok" : code[1];
  return "error";
}

function publicBudget(b) {
  if (!b) return null;
  return {
    enabled: b.enabled !== false,
    period: b.period === "day" ? "day" : "month",
    spendLimit: b.spendLimit ?? null,
    tokenLimit: b.tokenLimit ?? null,
    requestLimit: b.requestLimit ?? null,
    hardStop: b.hardStop === true,
  };
}

/** Everything the customer page shows, for one key record. */
export async function getCustomerUsage(rec, { now = new Date() } = {}) {
  const budget = await getBudget(keyScope(rec.id));
  // The budget counter only drives the budget card's ratio/state. Every number shown
  // (totals, breakdown, chart) comes from the fresh queries below, so they add up.
  const status = budget ? await budgetStatus(keyScope(rec.id), budget, { now }) : null;
  const period = budget?.period === "day" ? "day" : "month";
  const { start, end } = periodBounds(period, now);
  const startIso = start.toISOString();

  const db = await getAdapter();
  const spend = spendExpr(db);
  // Usage rows store the key reference, never the key string.
  const keyRef = keyRefForId(rec.id);

  const totals = db.get(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens, SUM(${spend}) AS spend
     FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
    [keyRef, startIso],
  );

  const byModel = db
    .all(
      `SELECT ${REQUESTED} AS model, COUNT(*) AS requests, COALESCE(SUM(promptTokens), 0) AS inputTokens, COALESCE(SUM(completionTokens), 0) AS outputTokens, SUM(${spend}) AS spend
       FROM usageHistory WHERE apiKey = ? AND timestamp >= ? GROUP BY 1 ORDER BY spend DESC, requests DESC LIMIT 100`,
      [keyRef, startIso],
    )
    .map((r) => ({
      model: r.model || UNKNOWN_MODEL,
      requests: n(r.requests),
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      spend: n(r.spend),
    }));

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const chartStart = new Date(today - (CHART_DAYS - 1) * 86_400_000);
  const dayRows = db.all(
    `SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS requests, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens, SUM(${spend}) AS spend
     FROM usageHistory WHERE apiKey = ? AND timestamp >= ? GROUP BY day`,
    [keyRef, chartStart.toISOString()],
  );
  const byDay = new Map(dayRows.map((r) => [r.day, r]));
  const daily = [];
  for (let i = 0; i < CHART_DAYS; i++) {
    const day = new Date(chartStart.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    daily.push({ date: day, requests: n(r?.requests), tokens: n(r?.tokens), spend: n(r?.spend) });
  }

  const recent = db
    .all(
      `SELECT timestamp, ${REQUESTED} AS model, status, promptTokens, completionTokens, ${spend} AS spend
       FROM usageHistory WHERE apiKey = ? ORDER BY timestamp DESC, id DESC LIMIT ${RECENT_LIMIT}`,
      [keyRef],
    )
    .map((r) => ({
      time: r.timestamp,
      model: r.model || UNKNOWN_MODEL,
      status: publicStatus(r.status),
      inputTokens: n(r.promptTokens),
      outputTokens: n(r.completionTokens),
      spend: n(r.spend),
    }));

  return {
    key: { name: rec.name || "API key" },
    period: {
      period,
      start: startIso,
      resetsAt: end.toISOString(),
      spend: n(totals?.spend),
      tokens: n(totals?.tokens),
      requests: n(totals?.requests),
    },
    budget: status
      ? {
          ...publicBudget(budget),
          ratio: n(status.ratio),
          state: status.state,
          blocked: status.blocked === true,
        }
      : null,
    daily,
    byModel,
    recent,
  };
}
