// Budget config per scope and the sent-alert ledger. Logic lives in src/lib/budgets.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const GLOBAL_SCOPE = "global";
export const keyScope = (keyId) => `key:${keyId}`;

export async function getBudgets() {
  const db = await getAdapter();
  const out = {};
  for (const r of db.all(`SELECT scope, data FROM budgets`)) out[r.scope] = parseJson(r.data, null);
  return out;
}

export async function getBudget(scope) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM budgets WHERE scope = ?`, [scope]);
  return row ? parseJson(row.data, null) : null;
}

export async function setBudget(scope, data) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO budgets(scope, data, updatedAt) VALUES(?, ?, ?) ON CONFLICT(scope) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
    [scope, stringifyJson(data), new Date().toISOString()],
  );
  return data;
}

export async function deleteBudget(scope) {
  const db = await getAdapter();
  db.run(`DELETE FROM budgets WHERE scope = ?`, [scope]);
  db.run(`DELETE FROM budgetAlerts WHERE scope = ?`, [scope]);
}

/** Records an alert; true only for the caller that inserted it (so it's sent once). */
export async function claimAlert(scope, periodKey, threshold) {
  const db = await getAdapter();
  const res = db.run(
    `INSERT OR IGNORE INTO budgetAlerts(scope, periodKey, threshold, sentAt) VALUES(?, ?, ?, ?)`,
    [scope, periodKey, threshold, new Date().toISOString()],
  );
  return (res?.changes ?? 0) > 0;
}

/** Sum of usage since `sinceIso`; `apiKey` null = every request. */
export async function sumUsageSince(apiKey, sinceIso) {
  const db = await getAdapter();
  const row = apiKey
    ? db.get(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens, COUNT(*) AS requests FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
        [apiKey, sinceIso],
      )
    : db.get(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens, COUNT(*) AS requests FROM usageHistory WHERE timestamp >= ?`,
        [sinceIso],
      );
  return { cost: Number(row?.cost) || 0, tokens: Number(row?.tokens) || 0, requests: Number(row?.requests) || 0 };
}

/** Provider/model pairs with tokens but no recorded cost since `sinceIso` (max 20). */
export async function zeroCostModelsSince(apiKey, sinceIso) {
  const db = await getAdapter();
  const where = apiKey ? "apiKey = ? AND timestamp >= ?" : "timestamp >= ?";
  const params = apiKey ? [apiKey, sinceIso] : [sinceIso];
  return db.all(
    `SELECT provider, model FROM usageHistory WHERE ${where} AND provider IS NOT NULL AND model IS NOT NULL GROUP BY provider, model HAVING COALESCE(SUM(cost), 0) = 0 AND SUM(promptTokens + completionTokens) > 0 LIMIT 20`,
    params,
  );
}
