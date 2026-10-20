// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
import { openRow, sealRow } from "./helpers/credentialsSeal.js";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, updateCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB.
// The export holds provider credentials DECRYPTED (portable to another install, which has
// its own key); the route serves it only after password re-auth. Import accepts plaintext,
// or envelopes this install's key can open, and stores everything encrypted.
export const EXPORT_CREDENTIALS_WARNING =
  "This file contains provider credentials (API keys, OAuth tokens) in plaintext. Store it like a password.";

export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    _warning: EXPORT_CREDENTIALS_WARNING,
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...openRow("providerConnections", r.id, parseJson(r.data, {})), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...openRow("proxyPools", r.id, parseJson(r.data, {})), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt, access: keyAccessFromColumns(r.accessRestricted, r.accessAllow) })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    budgets: db.all(`SELECT scope, data FROM budgets`).map((r) => ({ scope: r.scope, ...parseJson(r.data, {}) })),
    pricePlans: db.all(`SELECT id, data FROM pricePlans`).map((r) => ({ ...parseJson(r.data, {}), id: r.id })),
    keyPlans: db.all(`SELECT keyId, planId FROM apiKeyPlans`),
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();
  const { NON_EXPORTED_SETTING_KEYS } = await import("./repos/settingsRepo.js");
  const currentSettings = parseJson(db.get(`SELECT data FROM settings WHERE id = 1`)?.data, {});
  let budgets = null;
  if (Array.isArray(payload.budgets)) {
    const { validateBudget } = await import("@/lib/budgets/index.js");
    budgets = payload.budgets.map(({ scope, ...rest }) => {
      if (typeof scope !== "string" || !(scope === "global" || /^key:[\w-]{1,64}$/.test(scope))) throw new Error("budgets: invalid scope");
      const checked = validateBudget(rest, { isKey: scope !== "global" });
      if (checked.error) throw new Error(`budgets ${scope}: ${checked.error}`);
      return [scope, checked.value];
    });
  }

  let pricePlans = null;
  let keyPlans = [];
  if (Array.isArray(payload.pricePlans)) {
    const { validatePlan, PLAN_ID_RE } = await import("@/lib/billing/index.js");
    pricePlans = payload.pricePlans.map(({ id, ...rest }) => {
      if (typeof id !== "string" || !PLAN_ID_RE.test(id)) throw new Error("pricePlans: invalid id");
      const checked = validatePlan(rest);
      if (checked.error) throw new Error(`pricePlans ${id}: ${checked.error}`);
      return [id, checked.value];
    });
    const ids = new Set(pricePlans.map(([id]) => id));
    // Only assignments for keys in this backup and plans that exist; the rest are dropped.
    const keyIds = new Set((payload.apiKeys || []).map((k) => k?.id).filter((id) => typeof id === "string"));
    keyPlans = (Array.isArray(payload.keyPlans) ? payload.keyPlans : []).filter(
      (k) => typeof k?.keyId === "string" && keyIds.has(k.keyId) && ids.has(k.planId),
    );
  }

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    // Older backups have no budgets: keep this install's own.
    if (budgets) {
      db.run(`DELETE FROM budgets`);
      for (const [scope, data] of budgets) {
        db.run(`INSERT INTO budgets(scope, data, updatedAt) VALUES(?, ?, ?)`, [scope, stringifyJson(data), new Date().toISOString()]);
      }
    }
    // Older backups have no price plans: keep this install's own.
    if (pricePlans) {
      db.run(`DELETE FROM pricePlans`);
      db.run(`DELETE FROM apiKeyPlans`);
      for (const [id, data] of pricePlans) {
        db.run(`INSERT INTO pricePlans(id, data, updatedAt) VALUES(?, ?, ?)`, [id, stringifyJson(data), new Date().toISOString()]);
      }
      for (const k of keyPlans) db.run(`INSERT OR REPLACE INTO apiKeyPlans(keyId, planId) VALUES(?, ?)`, [k.keyId, k.planId]);
    }
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      // A backup never carries the redeploy hook: keep this install's own, ignore any in the file.
      const next = { ...payload.settings };
      for (const k of NON_EXPORTED_SETTING_KEYS) {
        if (currentSettings[k] === undefined) delete next[k];
        else next[k] = currentSettings[k];
      }
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(sealRow("settings", 1, openRow("settings", 1, next)))]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(sealRow("providerConnections", id, openRow("providerConnections", id, rest))), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(sealRow("proxyPools", id, openRow("proxyPools", id, rest))), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      // Per-key access: a backup without `access` (older version) restores
      // unrestricted, exactly as before; a malformed `access` is refused.
      let access = KEY_ACCESS_UNRESTRICTED;
      if (k.access !== undefined) {
        const checked = validateKeyAccessInput(k.access);
        if (!checked.ok) throw new Error(`apiKeys ${k.id}: ${checked.error}`);
        access = checked.value;
      }
      const cols = keyAccessToColumns(access);
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), cols.accessRestricted, cols.accessAllow]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
