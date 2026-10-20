// Usage rows store a key reference instead of the client's raw API key
// (helpers/usageKeyRef.js): usageHistory.apiKey and the byApiKey buckets in
// usageDaily.data become "id:<apiKeys.id>", or "key-<hash>" for a key that is no
// longer (or never was) in apiKeys. One-way: the raw keys are not kept anywhere
// but apiKeys.
// The first run treats every stored value as a raw key: no ref existed before, so a
// client-sent "id:<x>" is hashed, never trusted. A repeat run (the _meta marker is
// set) only converts what isn't a valid ref, so running it twice is safe. migrate.js
// re-runs that backfill on boot if raw keys reappear (an older version after a
// downgrade) and VACUUMs until the usageKeysScrubbed flag says it has.
import { getMetaSync, setMetaSync } from "../helpers/metaStore.js";
import { backfillUsageKeyRefs } from "../helpers/usageKeyRef.js";

export const MIGRATED_META_KEY = "usageKeyRefsMigrated";

export default {
  version: 5,
  name: "usage-key-refs",
  up(db) {
    const first = getMetaSync(db, MIGRATED_META_KEY, "0") !== "1";
    backfillUsageKeyRefs(db, { allRaw: first });
    setMetaSync(db, MIGRATED_META_KEY, "1");
  },
};
