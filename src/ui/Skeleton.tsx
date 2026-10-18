import { cn } from "./cn";

/**
 * Placeholder block shown while data loads. Give it the size of what it stands
 * in for so nothing shifts when the real content arrives. It only fades in after
 * 250ms (`.skeleton` in globals.css), so fast loads never flash it.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block rounded bg-surface-3", className)} />;
}

/** Stand-in for a list pane of `ListRow`s (leading logo, title, subtitle). */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-1 pt-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2.5 py-2">
          <Skeleton className="size-[22px] rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
