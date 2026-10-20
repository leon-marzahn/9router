"use client";

import { cn } from "@/ui/cn";

export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  size = "md",
  className,
}) {
  const sizes = {
    sm: { track: "w-8 h-[18px]", thumb: "size-3.5", translate: "translate-x-[15px]" },
    md: { track: "w-10 h-[22px]", thumb: "size-[18px]", translate: "translate-x-[19px]" },
    lg: { track: "w-12 h-[26px]", thumb: "size-[22px]", translate: "translate-x-[23px]" },
  };

  const handleClick = () => {
    if (!disabled && onChange) onChange(!checked);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label || undefined}
        disabled={disabled}
        onClick={handleClick}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
          // Visual size stays; the ::after stretches the tap target past 40px (as in src/ui/Switch).
          "after:absolute after:-inset-x-1 after:-inset-y-3",
          "transition-colors duration-200 ease-in-out",
          "focus-visible:outline-none focus-visible:shadow-focus",
          checked ? "bg-success" : "bg-surface-3",
          sizes[size].track,
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block rounded-full bg-white shadow-sm",
            "transform transition duration-200 ease-in-out",
            checked ? sizes[size].translate : "translate-x-0.5",
            sizes[size].thumb,
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col">
          {label && (
            <span className="text-[13px] font-medium text-text">{label}</span>
          )}
          {description && (
            <span className="text-xs text-text-muted">{description}</span>
          )}
        </div>
      )}
    </div>
  );
}
