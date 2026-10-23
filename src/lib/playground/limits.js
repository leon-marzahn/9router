// In-memory abuse limits for the dashboard Playground: requests per minute and
// concurrent requests, each enforced per session AND per client IP. Resets on restart.
// The IP comes from getClientIp (custom-server.js trust rules), never raw X-Forwarded-For.

export const RATE_LIMIT_PER_MIN = 20;
export const MAX_CONCURRENT = 2;
const WINDOW_MS = 60_000;
// A slot whose stream never closed (client vanished without a cancel) frees itself.
const SLOT_TTL_MS = 10 * 60_000;
const MAX_BUCKETS = 10_000;

const state = (global._regentPlaygroundLimits ??= { hits: new Map(), active: new Map() });

function prune(now) {
  if (state.hits.size <= MAX_BUCKETS) return;
  for (const [k, list] of state.hits)
    if (!list.length || now - list[list.length - 1] > WINDOW_MS) state.hits.delete(k);
}

function recentHits(key, now) {
  const list = (state.hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  state.hits.set(key, list);
  return list;
}

function activeSlots(key, now) {
  const slots = (state.active.get(key) || []).filter(
    (s) => !s.released && now - s.at < SLOT_TTL_MS,
  );
  if (slots.length) state.active.set(key, slots);
  else state.active.delete(key);
  return slots;
}

/**
 * Takes one request slot for every bucket key (e.g. ["session:…", "ip:…"]).
 * Returns { release } on success, or { error, retryAfter } when a limit is hit
 * (nothing is taken then). `release` is idempotent.
 */
export function acquirePlaygroundSlot(keys, now = Date.now()) {
  prune(now);
  for (const key of keys) {
    const hits = recentHits(key, now);
    if (hits.length >= RATE_LIMIT_PER_MIN) {
      return {
        error: `Playground rate limit reached (${RATE_LIMIT_PER_MIN} requests per minute). Try again shortly.`,
        retryAfter: Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000)),
      };
    }
    if (activeSlots(key, now).length >= MAX_CONCURRENT) {
      return {
        error: `Too many Playground requests in flight (max ${MAX_CONCURRENT}). Wait for one to finish.`,
        retryAfter: 5,
      };
    }
  }
  const slots = keys.map((key) => {
    state.hits.get(key).push(now);
    const slot = { at: now, released: false };
    state.active.set(key, [...(state.active.get(key) || []), slot]);
    return slot;
  });
  return {
    release() {
      for (const s of slots) s.released = true;
    },
  };
}

/** Tests only. */
export function resetPlaygroundLimits() {
  state.hits.clear();
  state.active.clear();
}
