// API keys for the dashboard Playground. The Playground calls the gateway AS a real key
// the user picks, so access lists, budgets, price plans and usage all apply exactly as
// for /v1. Key secrets stay on the server: the browser only ever sees id and name.
//
// "playground" (PLAYGROUND_KEY_ID) is a placeholder the client may send before the
// Playground key exists; it resolves to the key created on first use (or reused).
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { createApiKey, getApiKeyById, getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { filterModelsListForKey } from "@/sse/services/keyAccess.js";

export const PLAYGROUND_KEY_ID = "playground";
export const PLAYGROUND_KEY_NAME = "Playground";
const META_KEY = "playgroundKeyId";
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MODEL_IDS = 2000;

export const isValidKeyId = (v) => typeof v === "string" && KEY_ID_RE.test(v);

let creating = null;

/**
 * The Playground key: the one recorded in _meta, else an existing key named
 * "Playground", else a new one (no price plan, unrestricted). Idempotent, and
 * concurrent first uses share one creation.
 */
export function ensurePlaygroundKey() {
  creating ??= (async () => {
    const recorded = await getMeta(META_KEY);
    if (recorded) {
      const rec = await getApiKeyById(recorded);
      if (rec) return rec;
    }
    const byName = (await getApiKeys()).find((k) => k.name === PLAYGROUND_KEY_NAME);
    const rec = byName || (await createApiKey(PLAYGROUND_KEY_NAME, await getConsistentMachineId()));
    await setMeta(META_KEY, rec.id);
    return rec;
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** The key record for a Playground keyId (with its secret: server-side only), or null. */
export async function resolvePlaygroundKey(keyId) {
  if (keyId === PLAYGROUND_KEY_ID) return ensurePlaygroundKey();
  if (!isValidKeyId(keyId)) return null;
  return getApiKeyById(keyId);
}

/** Keys for the picker: id, name, state. Never the secret. */
export async function listPlaygroundKeys() {
  const keys = await getApiKeys();
  const recorded = await getMeta(META_KEY);
  const playground =
    keys.find((k) => k.id === recorded) || keys.find((k) => k.name === PLAYGROUND_KEY_NAME);
  const out = keys.map((k) => ({
    id: k.id,
    name: k.name || k.id.slice(0, 8),
    isActive: k.isActive,
    restricted: !!k.access?.restricted,
    playground: k.id === playground?.id,
  }));
  // Not created yet: offer the placeholder, created on first send.
  if (!playground)
    out.unshift({
      id: PLAYGROUND_KEY_ID,
      name: PLAYGROUND_KEY_NAME,
      isActive: true,
      restricted: false,
      playground: true,
    });
  return out;
}

/** The subset of `models` the key may call (same check as /v1), or null for an unknown key. */
export async function allowedModelsFor(keyId, models) {
  const ids = (Array.isArray(models) ? models : [])
    .filter((m) => typeof m === "string" && m.length <= 200)
    .slice(0, MAX_MODEL_IDS);
  if (keyId === PLAYGROUND_KEY_ID && !(await getMeta(META_KEY))) return ids;
  const rec = await resolvePlaygroundKey(keyId);
  if (!rec) return null;
  if (!rec.access?.restricted) return ids;
  const ctx = {
    keyId: rec.id,
    keyName: rec.name || rec.id,
    allow: rec.access.allow || [],
    _sets: null,
  };
  // The /v1/models filter: same resolution as the request-time check, without its deny logs.
  return (
    await filterModelsListForKey(
      ctx,
      ids.map((id) => ({ id })),
    )
  ).map((m) => m.id);
}
