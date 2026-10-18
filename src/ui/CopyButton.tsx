"use client";

import { useEffect, useRef, useState } from "react";
import { IconButton } from "./Button";

/** Icon button that copies `value` and shows a check for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <IconButton
      icon={done ? "check" : "content_copy"}
      label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1200);
      }}
    />
  );
}
