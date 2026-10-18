"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon, SearchInput, Skeleton } from "@/ui";
import { cn } from "@/ui/cn";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools.js";
import ToolDetailClientJs from "../[toolId]/ToolDetailClient";

const ToolDetailClient = ToolDetailClientJs as unknown as React.ComponentType<{
  toolId: string;
  embedded?: boolean;
  onWrite?: () => void;
}>;

type State = "connected" | "installed" | "missing" | "guide" | "unknown";
interface Tool {
  id: string;
  name: string;
  image?: string;
  description?: string;
  configType?: string;
}
type Status = { installed?: boolean; hasRegent?: boolean } | null;

const TOOLS = Object.values(CLI_TOOLS) as Tool[];
const MITM = Object.values(MITM_TOOLS) as Tool[];

const GROUPS: { state: State; label: string }[] = [
  { state: "connected", label: "Connected" },
  { state: "installed", label: "Installed, not connected" },
  { state: "unknown", label: "Status unknown" },
  { state: "missing", label: "Not found on this machine" },
  { state: "guide", label: "Copy-paste setup" },
];
const LABEL: Record<State, string> = {
  connected: "Connected to regent",
  installed: "Installed, not connected",
  missing: "Not found on this machine",
  guide: "Set up by pasting the settings into the tool",
  unknown: "Couldn't check",
};
const DOT: Record<State, string> = {
  connected: "bg-success",
  installed: "bg-warning",
  missing: "bg-transparent ring-1 ring-inset ring-text-subtle",
  guide: "bg-info",
  unknown: "bg-text-subtle",
};

function stateOf(t: Tool, s: Status | undefined): State {
  if (t.configType === "guide") return "guide";
  if (!s) return "unknown";
  if (!s.installed) return "missing";
  return s.hasRegent ? "connected" : "installed";
}

function ToolIcon({ t, size }: { t: Tool; size: number }) {
  return t.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={t.image} alt="" width={size} height={size} className="shrink-0 rounded-md object-contain" />
  ) : (
    <span className="grid shrink-0 place-items-center rounded-md bg-surface-2 text-[10px] font-semibold" style={{ width: size, height: size }}>
      {t.name.slice(0, 2)}
    </span>
  );
}

export function CliToolsWorkbench() {
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("tool");
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState<Record<string, Status> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/all-statuses", { cache: "no-store" });
      setStatuses(res.ok ? await res.json() : {});
    } catch {
      setStatuses({});
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const select = (id: string | null) =>
    router.replace(id ? `/dashboard/cli-tools?tool=${encodeURIComponent(id)}` : "/dashboard/cli-tools", { scroll: false });

  const tool = TOOLS.find((t) => t.id === sel);
  const state = tool ? stateOf(tool, statuses?.[tool.id]) : null;
  const filter = (t: Tool) => !q || t.name.toLowerCase().includes(q.toLowerCase());

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn("flex min-h-0 w-full flex-1 flex-col border-r border-border bg-pane md:w-[320px] md:flex-none", tool && "hidden md:flex")}>
        <div className="p-3">
          <SearchInput placeholder="Search tools" value={q} onChange={(e) => setQ(e.target.value)} shortcut="/" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {GROUPS.map((g) => {
            const items = TOOLS.filter((t) => filter(t) && (statuses ? stateOf(t, statuses[t.id]) : t.configType === "guide" ? "guide" : "unknown") === g.state);
            if (!items.length) return null;
            if (g.state === "unknown" && !statuses)
              return (
                <div key={g.state} className="space-y-1 px-2.5 py-2">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-8 w-full rounded-lg" />
                  ))}
                </div>
              );
            return (
              <div key={g.state} className="mb-3">
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-text-subtle">
                  {g.label} <span className="font-normal">{items.length}</span>
                </div>
                <div className="space-y-1">
                  {items.map((t) => {
                    const active = t.id === sel;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => select(active ? null : t.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                          active ? "bg-accent-soft ring-1 ring-accent-ring" : "hover:bg-surface-2",
                        )}
                      >
                        <ToolIcon t={t} size={22} />
                        <span className={cn("min-w-0 flex-1 truncate text-[13px]", active && "font-medium text-accent-text")}>{t.name}</span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", DOT[g.state])} />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {MITM.filter(filter).length > 0 && (
            <div className="mb-3">
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-text-subtle">
                Through a local intercept (MITM)
              </div>
              {MITM.filter(filter).map((t) => (
                <Link
                  key={t.id}
                  href="/dashboard/mitm"
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-2"
                >
                  <ToolIcon t={t} size={22} />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <Icon name="arrow_outward" size={14} className="text-text-subtle" />
                </Link>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section className={cn("min-h-0 flex-1 overflow-y-auto", !tool && "hidden md:block")}>
        {tool && state ? (
          <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8 md:py-8">
            <button type="button" onClick={() => select(null)} className="flex items-center gap-1 text-[13px] text-text-muted md:hidden">
              <Icon name="arrow_back" size={16} /> CLI Tools
            </button>
            <header className="flex items-start gap-3">
              <ToolIcon t={tool} size={40} />
              <div className="min-w-0">
                <h1 className="font-display text-2xl">{tool.name}</h1>
                <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-text-muted">
                  <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[state])} />
                  {LABEL[state]}
                </p>
                {tool.description && <p className="mt-1 text-[13px] text-text-muted">{tool.description}</p>}
              </div>
            </header>
            <ToolDetailClient key={tool.id} toolId={tool.id} embedded onWrite={() => void load()} />
          </div>
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-[13px] text-text-muted">
            <div className="flex max-w-sm flex-col items-center gap-2">
              <Icon name="terminal" size={28} className="text-text-subtle" />
              Pick a tool to point it at regent. Each one keeps its settings in its own config file; this writes them for you and keeps a backup.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
