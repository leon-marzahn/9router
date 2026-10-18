"use client";

import { useEffect, useState } from "react";
import { Button, Eyebrow, Icon } from "@/ui";
import type { Cooldown } from "../model";

function remaining(until: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Models benched after upstream errors; they rejoin rotation automatically when the timer ends. */
export function Cooldowns({
  cooldowns,
  onClear,
}: {
  cooldowns: Cooldown[];
  onClear: (model: string) => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [clearing, setClearing] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = cooldowns.filter((c) => new Date(c.until).getTime() > now);
  if (active.length === 0) return null;

  return (
    <>
      <Eyebrow className="mb-2 mt-10">Model cooldowns</Eyebrow>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {active.map((c) => (
          <div key={c.model} className="flex items-center gap-3 px-4 py-3">
            <Icon name="schedule" size={18} className="text-warning-text" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">
                {c.model === "__all" ? "All models" : c.model}
              </div>
              <div className="truncate text-[11px] text-text-muted">
                Back in <span className="tabular-nums">{remaining(c.until, now)}</span> ·{" "}
                {c.accounts.join(", ")}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              loading={clearing === c.model}
              onClick={async () => {
                setClearing(c.model);
                await onClear(c.model);
                setClearing(null);
              }}
            >
              Clear
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
