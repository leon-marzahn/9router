import { cn } from "./cn";

/** Material Symbols Outlined glyph. `size` is the font size in px. */
export function Icon({ name, size = 18, filled, className }: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("material-symbols-outlined shrink-0 leading-none", filled && "fill-1", className)}
      style={{ fontSize: size }}
    >
      {name}
    </span>
  );
}
