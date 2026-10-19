"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";
import { Kbd } from "./Field";
import { ListRow } from "./ListRow";

/**
 * The workbench list pane: 330px beside the detail on md+, full width below
 * (and hidden while something is selected, so mobile shows list *or* detail).
 * Scrolls the row with `data-id === selected` into view.
 */
export function WorkbenchList({
  selected,
  header,
  hints,
  children,
}: {
  /** Selected row id; null shows the list on mobile. */
  selected: string | null;
  /** Search, scope, kind switch… (padded `space-y-2 p-3`). */
  header: ReactNode;
  /** Keyboard hints for the footer, e.g. `[["↑↓", "move"], ["esc", "overview"]]`. */
  hints?: [key: string, label: string][];
  /** `ListGroup`s / `ListSkeleton`. */
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected)
      bodyRef.current
        ?.querySelector(`[data-id="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <section
      className={cn(
        "flex w-full shrink-0 flex-col border-r border-border bg-pane md:w-[330px]",
        selected && "hidden md:flex",
      )}
    >
      <div className="space-y-2 p-3">{header}</div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {children}
      </div>
      {hints && hints.length > 0 && (
        <div className="hidden gap-3 border-t border-border px-3 py-2 text-[11px] text-text-subtle md:flex">
          {hints.map(([key, label]) => (
            <span key={key}>
              <Kbd>{key}</Kbd> {label}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The detail / overview pane next to `WorkbenchList`. While something is
 * selected it starts with a ghost `← {backLabel}` button on mobile; with
 * nothing selected it is hidden on mobile (the list shows instead).
 */
export function WorkbenchDetail({
  selected,
  backLabel,
  onBack,
  children,
}: {
  selected: boolean;
  /** e.g. "All providers". */
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <main className={cn("min-w-0 flex-1 overflow-y-auto", !selected && "hidden md:block")}>
      {selected && (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 px-4 pt-4 text-[13px] text-text-muted hover:text-text md:hidden"
        >
          <Icon name="arrow_back" size={16} /> {backLabel}
        </button>
      )}
      {children}
    </main>
  );
}

/**
 * Mobile-only first row of a `WorkbenchList` that opens the page's overview
 * as its own screen (desktop already shows it with nothing selected). The
 * page keeps that screen in the URL as `?view=overview` and counts it as
 * `selected` for `WorkbenchList` / `WorkbenchDetail`.
 */
export function WorkbenchOverviewRow({
  icon,
  subtitle,
  onClick,
}: {
  /** Material icon for the page, e.g. "dns". */
  icon: string;
  /** What the overview holds, one short line. */
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <ListRow
      className="md:hidden"
      onClick={onClick}
      leading={<Icon name={icon} size={16} className="text-text-muted" />}
      title="Overview"
      subtitle={subtitle}
      trailing={<Icon name="chevron_right" size={16} className="text-text-subtle" />}
    />
  );
}
