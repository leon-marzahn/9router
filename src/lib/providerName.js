import { getProviderNodeById } from "@/lib/db/repos/nodesRepo.js";
import REGISTRY from "open-sse/providers/registry/index.js";

/**
 * Human label for a provider id, resolved at read time so renames show up.
 * Custom nodes (`openai-compatible-chat-<uuid>` etc.) never show their internal id:
 * - default: node name for custom nodes, registry display name for built-ins
 * - `prefix: true`: the way clients address models — node prefix (else its name)
 *   for custom nodes, the id itself for built-ins
 * Anything unknown (e.g. a deleted node) falls back to the id.
 * @param {string} id
 * @param {Map<string, string>} [cache]
 * @param {{ prefix?: boolean }} [opts]
 */
export async function providerName(id, cache = new Map(), { prefix = false } = {}) {
  if (!id) return undefined;
  if (cache.has(id)) return cache.get(id);
  let name = id;
  try {
    const entry = REGISTRY.find((p) => p.id === id || p.alias === id);
    if (entry) {
      if (!prefix && entry.display?.name) name = entry.display.name;
    } else {
      const node = await getProviderNodeById(id);
      if (prefix && node?.prefix) name = node.prefix;
      else if (node?.name) name = node.name;
    }
  } catch {
    /* keep the id */
  }
  cache.set(id, name);
  return name;
}
