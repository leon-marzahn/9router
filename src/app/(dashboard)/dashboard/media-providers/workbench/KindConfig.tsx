import type { ReactNode } from "react";
import { Eyebrow, Icon } from "@/ui";

type Config = Record<string, unknown>;
type Field = {
  label: string;
  format: (v: never) => ReactNode;
  link?: boolean;
  mono?: boolean;
};

// Only the fields people act on; everything else in the registry config is plumbing.
const FIELDS: Record<string, Field> = {
  mode: { label: "Mode", format: (v: string) => v },
  defaultModel: { label: "Model", format: (v: string) => v, mono: true },
  baseUrl: { label: "Endpoint", format: (v: string) => v, link: true, mono: true },
  costPerQuery: {
    label: "Cost / call",
    format: (v: number) => (v === 0 ? "Free" : `$${v.toFixed(4)}`),
  },
  pricingUrl: { label: "Pricing", format: () => "View pricing", link: true },
  freeTier: { label: "Free tier", format: (v: string) => String(v) },
  freeMonthlyQuota: {
    label: "Free quota",
    format: (v: number) =>
      v === 0 ? "—" : v >= 999999 ? "Unlimited" : `${v.toLocaleString()} / mo`,
  },
  searchTypes: { label: "Types", format: (v: string[]) => v.join(", ") },
  formats: { label: "Formats", format: (v: string[]) => v.join(", ") },
  maxMaxResults: { label: "Max results", format: (v: number) => v },
  maxCharacters: { label: "Max chars", format: (v: number) => v.toLocaleString() },
};

const isSafeLink = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/** Registry facts for this provider × kind (endpoint, pricing, limits). */
export function KindConfig({ title, config }: { title: string; config: unknown }) {
  if (!config || typeof config !== "object") return null;
  const c = config as Config;
  const rows = Object.entries(FIELDS).filter(([k]) => c[k] != null && c[k] !== "");
  if (rows.length === 0) return null;
  return (
    <section>
      <Eyebrow className="mb-2">{title}</Eyebrow>
      <dl className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {rows.map(([k, f]) => {
          const raw = c[k];
          const value = (f.format as (v: unknown) => ReactNode)(raw);
          return (
            <div key={k} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <dt className="w-24 shrink-0 text-xs text-text-muted">{f.label}</dt>
              <dd
                className={`min-w-0 flex-1 truncate text-[13px] ${f.mono ? "font-mono text-xs" : ""}`}
              >
                {f.link && isSafeLink(raw) ? (
                  <a
                    href={raw}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-accent-text hover:underline"
                  >
                    <span className="truncate">{value}</span>
                    <Icon name="open_in_new" size={13} className="shrink-0" />
                  </a>
                ) : (
                  value
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
