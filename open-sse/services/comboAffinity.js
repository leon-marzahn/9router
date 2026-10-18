import { createHash } from "node:crypto";

/**
 * Combo step ordering for "Per chat" and "stay after a fallback".
 *
 * - Per chat: each conversation gets its own fixed preference order over the
 *   combo's steps by rendezvous (highest-random-weight) hashing of
 *   conversation key × step. Conversations spread across steps; removing a
 *   step only moves the conversations that were on it.
 * - Stay after a fallback: once a conversation was served by a step other
 *   than its first choice, keep sending it there (its prompt cache is warm)
 *   until that step fails or the memory expires after an hour idle.
 *
 * Only opaque digests are used as keys (see src/sse/services/cacheAffinity.js);
 * the memory is per process and holds combo name + digest + step name.
 */

export const STICKY_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const sticky = new Map(); // `${combo}\0${key}` -> { model, at }

const weight = (key, step) =>
  createHash("sha256").update(`${key}\0${step}`).digest().readUInt32BE(0);

/** The conversation's preference order over the steps (stable for a key). */
export function orderForConversation(models, key) {
  if (!key || models.length < 2) return [...models];
  return models
    .map((m, i) => ({ m, i, w: weight(key, m) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.m);
}

const id = (combo, key) => `${combo}\0${key}`;

export function rememberedStep(combo, key, now = Date.now()) {
  if (!key) return null;
  const e = sticky.get(id(combo, key));
  if (!e) return null;
  if (now - e.at > STICKY_TTL_MS) {
    sticky.delete(id(combo, key));
    return null;
  }
  return e.model;
}

export function rememberStep(combo, key, model, now = Date.now()) {
  if (!key) return;
  const k = id(combo, key);
  sticky.delete(k);
  sticky.set(k, { model, at: now });
  // Map keeps insertion order: drop the oldest when over the cap.
  while (sticky.size > MAX_ENTRIES) sticky.delete(sticky.keys().next().value);
}

export function forgetStep(combo, key) {
  if (key) sticky.delete(id(combo, key));
}

export function resetComboAffinity(combo) {
  if (!combo) return sticky.clear();
  for (const k of sticky.keys()) if (k.startsWith(`${combo}\0`)) sticky.delete(k);
}

/** Put `first` at the front if it's one of the steps. */
export function bringToFront(models, first) {
  if (!first || !models.includes(first)) return models;
  return [first, ...models.filter((m) => m !== first)];
}

/** Steps known not to be ready go last (not dropped: the check is best-effort). */
export async function readyFirst(models, isReady) {
  if (typeof isReady !== "function" || models.length < 2) return models;
  const flags = await Promise.all(
    models.map((m) =>
      Promise.resolve()
        .then(() => isReady(m))
        .then((v) => v !== false, () => true),
    ),
  );
  return [...models.filter((_, i) => flags[i]), ...models.filter((_, i) => !flags[i])];
}
