// Per-key pricing (src/lib/billing): named price plans, which plan each API key uses,
// and the customer charge recorded on every usage row next to its upstream cost.
// Rows written before this migration were never priced for a customer: charge = cost.
export default {
  version: 4,
  name: "key-pricing",
  up(db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS pricePlans (id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS apiKeyPlans (keyId TEXT PRIMARY KEY, planId TEXT NOT NULL)",
    );
    const hasUsage = db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usageHistory'",
    );
    if (!hasUsage) return;
    const cols = new Set(db.all("PRAGMA table_info(usageHistory)").map((r) => r.name));
    if (!cols.has("charge")) db.exec("ALTER TABLE usageHistory ADD COLUMN charge REAL");
    db.run("UPDATE usageHistory SET charge = COALESCE(cost, 0) WHERE charge IS NULL");
  },
};
