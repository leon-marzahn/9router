// Routing traces for the Usage request inspector (src/lib/requestTrace.js).
// Metadata only (no bodies or credentials); bounded by requestTracesRepo.
export default {
  version: 2,
  name: "request-traces",
  up(db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS requestTraces (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, data TEXT NOT NULL)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_rt_ts ON requestTraces(timestamp)");
  },
};
