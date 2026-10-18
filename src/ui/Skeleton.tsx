import { cn } from "./cn";

/**
 * Placeholder block shown while data loads. Give it the size of what it stands
 * in for so nothing shifts when the real content arrives. It only fades in after
 * 250ms (`.skeleton` in globals.css), so fast loads never flash it.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block rounded bg-surface-3", className)} />;
}
