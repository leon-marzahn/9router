// Pure logic behind the Playground key picker (usePlaygroundKeys): which key is
// selected, what the key list may contain, and which models a key may call.
import type { ProviderGroup } from "./chat";

/** A key as the picker sees it: never the secret. */
export interface PlaygroundKey {
  id: string;
  name: string;
  isActive: boolean;
  restricted: boolean;
  playground: boolean;
}

/** Placeholder the server turns into the auto-created "Playground" key. */
export const PLAYGROUND_KEY_ID = "playground";
export const KEY_STORAGE = "basic-chat.keyId";

/**
 * Keys from /api/dashboard/chat/keys, copied field by field so nothing else (a secret
 * a future server change might add) reaches state. null when the payload is unusable.
 */
export function parseKeys(data: unknown): PlaygroundKey[] | null {
  const list = (data as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return null;
  return list
    .filter((k): k is Record<string, unknown> => !!k && typeof k === "object")
    .filter((k) => typeof k.id === "string" && k.id.length > 0)
    .map((k) => ({
      id: String(k.id),
      name: typeof k.name === "string" && k.name ? k.name : String(k.id).slice(0, 8),
      isActive: k.isActive !== false,
      restricted: k.restricted === true,
      playground: k.playground === true,
    }));
}

/**
 * The key to send as: the saved one if it is still listed and active, else the
 * Playground key (the real id once it exists, the placeholder before). null until the
 * list has loaded (or when it failed): the chat must not send without a known key.
 */
export function resolveKeyId(keys: PlaygroundKey[] | null, saved: string): string | null {
  if (!keys) return null;
  const savedKey = keys.find((k) => k.id === saved && k.isActive);
  if (savedKey) return savedKey.id;
  return keys.find((k) => k.playground)?.id ?? PLAYGROUND_KEY_ID;
}

/** True when the key is not the Playground key: its usage lands on that key. */
export function billsAnotherKey(keys: PlaygroundKey[] | null, keyId: string | null): boolean {
  const key = keys?.find((k) => k.id === keyId);
  return !!key && !key.playground;
}

/** Model ids to ask the server about (what the request sends as `model`). */
export const requestModelIds = (groups: ProviderGroup[]): string[] =>
  groups.flatMap((g) => g.models.map((m) => m.requestModel || m.id));

/**
 * The allowed set for the selected key: only for a restricted key, and only once the
 * answer for THIS key has arrived (a stale answer for another key never applies).
 */
export function allowedFor(
  key: PlaygroundKey | null,
  fetched: { keyId: string; models: string[] } | null,
): Set<string> | null {
  if (!key?.restricted) return null;
  if (fetched?.keyId !== key.id) return new Set();
  return new Set(fetched.models);
}

/** Groups limited to the allowed models; all groups when there is no restriction. */
export function filterGroups(
  groups: ProviderGroup[],
  allowed: Set<string> | null,
): ProviderGroup[] {
  if (!allowed) return groups;
  return groups
    .map((g) => ({ ...g, models: g.models.filter((m) => allowed.has(m.requestModel || m.id)) }))
    .filter((g) => g.models.length > 0);
}
