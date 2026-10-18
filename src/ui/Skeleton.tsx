import { cn } from "./cn";

/**
 * Placeholder block shown while data loads. Give it the size of what it stands
 * in for so nothing shifts when the real content arrives.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block animate-pulse rounded bg-surface-3 motion-reduce:animate-none",
        className,
      )}
    />
  );
}
