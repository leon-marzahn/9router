"use client";

import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

/** Label + control + hint/error. Wrap any control (Input, Segmented, select…). */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-text">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-danger-text">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border max-md:h-10 border-border-strong bg-surface px-3 text-[13px] text-text outline-none transition-colors " +
  "placeholder:text-text-subtle focus:border-accent focus:shadow-focus dark:border-border";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }
>(function Input({ className, mono, ...rest }, ref) {
  return (
    <input ref={ref} className={cn(inputClass, mono && "font-mono text-xs", className)} {...rest} />
  );
});

/** Native select styled like Input. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cn(inputClass, "pr-8", className)} {...rest} />;
  },
);

/** Search input with leading icon and optional shortcut hint. */
export const SearchInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { shortcut?: string }
>(function SearchInput({ className, shortcut, ...rest }, ref) {
  return (
    <label
      className={cn(
        "flex h-9 min-w-0 items-center gap-2 rounded-lg max-md:h-10 bg-surface px-3 ring-1 ring-border focus-within:ring-accent-ring",
        className,
      )}
    >
      <Icon name="search" size={17} className="text-text-subtle" />
      <input
        ref={ref}
        className="h-full min-w-0 flex-1 self-stretch bg-transparent text-[13px] outline-none placeholder:text-text-subtle"
        {...rest}
      />
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </label>
  );
});

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded bg-surface-2 px-1.5 font-mono text-[10px] leading-4 text-text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
