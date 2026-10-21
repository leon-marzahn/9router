"use client";

import { useCallback, useEffect, useState } from "react";
import { pushRecent } from "@/ui/modelPickerLogic";
import { STORAGE_KEYS, keyboardInset, parseRecentModels } from "./chat";

/** Recently picked model ids, kept in this browser (best effort). */
export function useRecentModels() {
  // Read lazily (throws, so [] on the server); recents only show inside the picker
  // dialog, which never renders during hydration.
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return parseRecentModels(globalThis.localStorage.getItem(STORAGE_KEYS.recentModels));
    } catch {
      return [];
    }
  });
  const remember = useCallback((id: string) => {
    setRecent((prev) => {
      const next = pushRecent(prev, id);
      try {
        globalThis.localStorage.setItem(STORAGE_KEYS.recentModels, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return [recent, remember] as const;
}

/** Bottom inset the on-screen keyboard covers, so the composer can sit above it. */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset(globalThis.innerHeight, vv));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
