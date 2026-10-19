// Spend budgets (src/lib/budgets): one row per scope ("global" or "key:<apiKeyId>"),
// the alerts already sent (once per scope, period and threshold), and an index so
// the per-key period sum that seeds the in-memory counters stays cheap.
export default {
  version: 3,
  name: "budgets",
  up(db) {
    db.exec("CREATE TABLE IF NOT EXISTS budgets (scope TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)");
    db.exec(
      "CREATE TABLE IF NOT EXISTS budgetAlerts (scope TEXT NOT NULL, periodKey TEXT NOT NULL, threshold INTEGER NOT NULL, sentAt TEXT NOT NULL, PRIMARY KEY (scope, periodKey, threshold))",
    );
    const hasUsage = db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usageHistory'",
    );
    if (hasUsage) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)");
    }
  },
};
