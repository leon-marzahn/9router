import { cn } from "./cn";

/** Glyph paths of the Elizabeth's Proxy mark (crowned serif E) on a 64×64 grid. */
export const LOGO_GLYPH = [
  // crown
  "M19.5 24 L18.5 13 L25.5 18 L32 9.5 L38.5 18 L45.5 13 L44.5 24 Z",
  // E: stem, top bar + serif, middle bar, bottom bar + serif
  "M23 29 H29 V51 H23 Z",
  "M18 28 H44 V35 H40.5 V31.5 H18 Z",
  "M29 38 H39 V41.5 H29 Z",
  "M18 48.5 H42 V44.5 H45.5 V52 H18 Z",
];

/** The app mark: accent tile with the crowned E. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("shrink-0 text-accent", className)}
    >
      <rect width="64" height="64" rx="14" fill="currentColor" />
      {LOGO_GLYPH.map((d) => (
        <path key={d} d={d} className="fill-accent-fg" />
      ))}
    </svg>
  );
}
