// Server-safe: the old-URL redirect pages import this without the provider registry.

/** URL of the workbench for a kind / provider / combo. */
export function mediaHref(q: { kind?: string; provider?: string; combo?: string }): string {
  const sp = new URLSearchParams();
  if (q.kind) sp.set("kind", q.kind);
  if (q.provider) sp.set("provider", q.provider);
  if (q.combo) sp.set("combo", q.combo);
  const s = sp.toString();
  return s ? `/dashboard/media-providers?${s}` : "/dashboard/media-providers";
}
