// Usage rows store a key reference instead of the client's raw API key
// (helpers/usageKeyRef.js): usageHistory.apiKey and the byApiKey buckets in
// usageDaily.data become "id:<apiKeys.id>", or "key-<hash>" for a key that is no
// longer (or never was) in apiKeys. One-way: the raw keys are not kept anywhere
// but apiKeys. migrate.js re-runs the same backfill on boot if raw keys reappear
// (e.g. rows written by an older version after a downgrade).
import { backfillUsageKeyRefs } from "../helpers/usageKeyRef.js";

export default {
  version: 5,
  name: "usage-key-refs",
  up(db) {
    backfillUsageKeyRefs(db);
  },
};
