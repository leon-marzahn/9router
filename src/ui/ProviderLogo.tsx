"use client";

import type { ComponentType } from "react";
import ProviderIconJs from "@/shared/components/ProviderIcon";
import { cn } from "./cn";

// ProviderIcon is untyped JS; describe the props we use.
const ProviderIcon = ProviderIconJs as unknown as ComponentType<{
  src?: string | null;
  providerId?: string;
  alt: string;
  size?: number;
  className?: string;
  fallbackText?: string;
  fallbackColor?: string;
}>;

/** Provider logo with text fallback. Prefer `providerId`; pass `src` for custom icons. */
export function ProviderLogo({ providerId, src, name, size = 22, color, fallbackText, className }: {
  providerId?: string;
  src?: string | null;
  name: string;
  size?: number;
  color?: string;
  fallbackText?: string;
  className?: string;
}) {
  return (
    <ProviderIcon
      providerId={src ? undefined : providerId}
      src={src}
      alt={name}
      size={size}
      className={cn("rounded-md object-contain", className)}
      fallbackText={fallbackText || (providerId || name).slice(0, 2).toUpperCase()}
      fallbackColor={color}
    />
  );
}
