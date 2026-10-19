// Persisted routing traces (Usage request inspector). Rows are the sanitized,
// metadata-only snapshots from src/lib/requestTrace.js.
//
// Capped exactly like request details: the Settings → Request logging "keep"
// limit (observabilityMaxRecords / OBSERVABILITY_MAX_RECORDS), oldest rows
// pruned after every write batch, so traces and logged requests age out together.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getObservabilityConfig } from "./requestDetailsRepo.js";

const MAX_ROW_BYTES = 32 * 1024;

/** Upsert a batch of trace snapshots, then prune to the request-log limit. */
export async function saveRequestTraces(traces) {
  if (!Array.isArray(traces) || traces.length === 0) return;
  const db = await getAdapter();
  const { maxRecords } = await getObservabilityConfig();
  db.transaction(() => {
    for (const t of traces) {
      if (!t?.id || !t.timestamp) continue;
      const data = stringifyJson(t);
      if (data.length > MAX_ROW_BYTES) continue;
      db.run(
        `INSERT INTO requestTraces(id, timestamp, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, data = excluded.data`,
        [t.id, t.timestamp, data],
      );
    }
    pruneSync(db, maxRecords);
  });
}

function pruneSync(db, maxRecords) {
  if (!(maxRecords > 0)) return;
  const cnt = db.get(`SELECT COUNT(*) as c FROM requestTraces`);
  if (cnt && cnt.c > maxRecords) {
    db.run(
      `DELETE FROM requestTraces WHERE id IN (SELECT id FROM requestTraces ORDER BY timestamp ASC LIMIT ?)`,
      [cnt.c - maxRecords],
    );
  }
}

export async function getRequestTraceById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestTraces WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}
