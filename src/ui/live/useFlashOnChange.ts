import { useEffect, useRef, useState } from "react";

/**
 * Returns true for ~1.2s after `value` changes (not on first render).
 * Pair with the `animate-live-flash` class. Compares with Object.is, so pass
 * a primitive "version" (e.g. `${status}:${count}`), not a fresh object.
 */
export function useFlashOnChange(value: unknown, durationMs = 1200): boolean {
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), durationMs);
    return () => clearTimeout(t);
  }, [value, durationMs]);
  return flash;
}
