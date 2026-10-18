import { cn } from "./cn";
import { STATUS, type Status } from "./status";

/** Colored dot for a Status. `live` adds a ping ring for things currently in flight. */
export function StatusDot({
  status,
  live,
  className,
}: {
  status: Status;
  live?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0", className)}>
      {live && (
        <span
          className={cn("absolute inset-0 rounded-full animate-live-ping", STATUS[status].dot)}
        />
      )}
      <span className={cn("relative inline-flex size-full rounded-full", STATUS[status].dot)} />
    </span>
  );
}

/** Dot + label, colored by status. */
export function StatusLabel({
  status,
  label,
  className,
}: {
  status: Status;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs", STATUS[status].text, className)}
    >
      <StatusDot status={status} />
      {label ?? STATUS[status].label}
    </span>
  );
}
