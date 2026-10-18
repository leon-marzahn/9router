// PROTOTYPE (throwaway, branch prototype/request-pipelines-redesign): Request Pipelines layouts.
// ?variant=current|A|B|C. Variants use mock data and save nothing.
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/ui/cn";
import { VariantPlayground, VariantRecipes, VariantWorkbench } from "./Variants";

const VARIANTS = [
  { id: "current", label: "Current" },
  { id: "A", label: "A · Step workbench" },
  { id: "B", label: "B · Playground" },
  { id: "C", label: "C · Recipes + attach" },
] as const;

export function PipelinesPrototype({ current }: { current: ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const variant = params.get("variant") ?? "A";
  const body =
    variant === "current" ? (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10">{current}</div>
    ) : variant === "B" ? (
      <VariantPlayground />
    ) : variant === "C" ? (
      <VariantRecipes />
    ) : (
      <VariantWorkbench />
    );
  return (
    <>
      {body}
      <div className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-16px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full border border-border bg-surface p-1 text-xs shadow-elev">
        <span className="px-2 text-[10px] font-medium uppercase tracking-wider text-text-subtle">Prototype</span>
        {VARIANTS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => router.replace(`/dashboard/request-pipelines?variant=${v.id}`, { scroll: false })}
            className={cn("whitespace-nowrap rounded-full px-3 py-1.5", variant === v.id ? "bg-inverse text-inverse-fg" : "text-text-muted hover:bg-surface-2")}
          >
            {v.label}
          </button>
        ))}
      </div>
    </>
  );
}
