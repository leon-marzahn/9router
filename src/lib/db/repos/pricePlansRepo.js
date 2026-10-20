// Price plans and which plan each API key uses. Logic lives in src/lib/billing.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/** The plan for keys without one. Always exists logically (markup 0 when never saved). */
export const DEFAULT_PLAN_ID = "default";

export async function getPricePlans() {
  const db = await getAdapter();
  const out = {};
  for (const r of db.all(`SELECT id, data FROM pricePlans`)) out[r.id] = parseJson(r.data, null);
  return out;
}

export async function getPricePlan(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM pricePlans WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

export async function setPricePlan(id, data) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO pricePlans(id, data, updatedAt) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
    [id, stringifyJson(data), new Date().toISOString()],
  );
  return data;
}

/** Removes a plan; keys that used it fall back to the default plan. */
export async function deletePricePlan(id) {
  const db = await getAdapter();
  db.transaction(() => {
    db.run(`DELETE FROM pricePlans WHERE id = ?`, [id]);
    db.run(`DELETE FROM apiKeyPlans WHERE planId = ?`, [id]);
  });
}

/** { [keyId]: planId } for keys with a plan other than the default. */
export async function getKeyPlanIds() {
  const db = await getAdapter();
  const out = {};
  for (const r of db.all(`SELECT keyId, planId FROM apiKeyPlans`)) out[r.keyId] = r.planId;
  return out;
}

/** `planId` null or the default id = use the default plan. */
export async function setKeyPlanId(keyId, planId) {
  const db = await getAdapter();
  if (!planId || planId === DEFAULT_PLAN_ID) {
    db.run(`DELETE FROM apiKeyPlans WHERE keyId = ?`, [keyId]);
    return;
  }
  db.run(
    `INSERT INTO apiKeyPlans(keyId, planId) VALUES(?, ?) ON CONFLICT(keyId) DO UPDATE SET planId = excluded.planId`,
    [keyId, planId],
  );
}

/**
 * Usage totals for one key reference ("id:<keyId>", see helpers/usageKeyRef.js) between two ISO timestamps, per model.
 * Rows from before per-key pricing have charge = cost (migration 004).
 */
export async function sumKeyUsage(keyRef, fromIso, toIso) {
  const db = await getAdapter();
  return db.all(
    `SELECT provider, model, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(COALESCE(charge, cost)), 0) AS charge,
       COALESCE(SUM(promptTokens), 0) AS promptTokens, COALESCE(SUM(completionTokens), 0) AS completionTokens, COUNT(*) AS requests
     FROM usageHistory WHERE apiKey = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY provider, model ORDER BY charge DESC`,
    [keyRef, fromIso, toIso],
  );
}
