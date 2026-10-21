/** Pure filtering / grouping for `ModelPicker` (kept apart so it is unit-testable). */

export interface PickerModel {
  /** Unique value the picker selects. */
  id: string;
  /** Display name. */
  name: string;
  /** Shown under the name when it differs from it (e.g. the id sent upstream). */
  detail?: string;
}

export interface PickerGroup {
  providerId: string;
  /** Provider display name, used as the group header. */
  providerName: string;
  models: PickerModel[];
}

export interface PickerSection {
  key: string;
  title: string;
  /** Provider id of the section, for a logo (absent for "Recent"). */
  providerId?: string;
  models: (PickerModel & { providerId: string; providerName: string })[];
  /** Matching models in the group before the render cap (`models` may hold fewer). */
  total: number;
}

export const RECENT_LIMIT = 5;
/** Options rendered per provider group; the rest are reached by typing. */
export const GROUP_LIMIT = 50;

const hay = new WeakMap<PickerModel, string>();
function haystack(m: PickerModel): string {
  let h = hay.get(m);
  if (h === undefined) {
    h = `${m.id} ${m.name} ${m.detail ?? ""}`.toLowerCase();
    hay.set(m, h);
  }
  return h;
}

/**
 * Groups whose models match `query`: every whitespace-separated term must
 * appear in the model's id, name or detail. A term that matches the provider
 * name keeps the whole group's models (so "groq" lists Groq's models). Empty
 * groups are dropped; order is kept.
 */
export function filterModelGroups(groups: PickerGroup[], query: string): PickerGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return groups.filter((g) => g.models.length > 0);
  const out: PickerGroup[] = [];
  for (const g of groups) {
    const provider = `${g.providerName} ${g.providerId}`.toLowerCase();
    const models = g.models.filter((m) => {
      const h = haystack(m);
      return terms.every((t) => h.includes(t) || provider.includes(t));
    });
    if (models.length) out.push({ ...g, models });
  }
  return out;
}

/**
 * Sections to render: "Recent" (only while not searching, models that still
 * exist, most recent first, uncapped) then one section per provider group that
 * matches, capped at `limit` options (`total` keeps the full count).
 */
export function buildPickerSections(
  groups: PickerGroup[],
  query: string,
  recentIds: string[] = [],
  limit = GROUP_LIMIT,
): PickerSection[] {
  const withProvider = (g: PickerGroup) =>
    g.models.map((m) => ({ ...m, providerId: g.providerId, providerName: g.providerName }));
  const sections: PickerSection[] = [];
  if (!query.trim() && recentIds.length) {
    const byId = new Map(groups.flatMap(withProvider).map((m) => [m.id, m]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((m): m is NonNullable<typeof m> => !!m)
      .slice(0, RECENT_LIMIT);
    if (recent.length)
      sections.push({ key: "__recent", title: "Recent", models: recent, total: recent.length });
  }
  for (const g of filterModelGroups(groups, query)) {
    sections.push({
      key: g.providerId,
      title: g.providerName,
      providerId: g.providerId,
      models: withProvider({ ...g, models: g.models.slice(0, limit) }),
      total: g.models.length,
    });
  }
  return sections;
}

/** Option keys in display order (a model under "Recent" and its provider has two). */
export function optionKeys(sections: PickerSection[]): string[] {
  return sections.flatMap((s) => s.models.map((m) => `${s.key}::${m.id}`));
}

/** `id` moved to the front of the recent list, deduplicated and capped. */
export function pushRecent(recent: string[], id: string, limit = RECENT_LIMIT): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, limit);
}

/** Next active index for an arrow / Home / End key, or null for other keys. */
export function moveActive(key: string, current: number, count: number): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
