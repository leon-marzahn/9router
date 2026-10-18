import { twMerge } from "tailwind-merge";

type ClassValue = string | false | null | undefined | 0;

/** Join class names; later Tailwind classes win over earlier conflicting ones. */
export function cn(...classes: ClassValue[]): string {
  return twMerge(classes.filter(Boolean).join(" "));
}
