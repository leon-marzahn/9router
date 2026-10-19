"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  ListSkeleton,
  ProviderLogo,
  SearchInput,
  StatusDot,
  StatusLabel,
  WorkbenchDetail,
  WorkbenchList,
  useListKeyboard,
  type Status as UiStatus,
} from "@/ui";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools.js";
import ToolDetailClientJs from "../[toolId]/ToolDetailClient";
import { ConnectPanel } from "../connect/ConnectPanel";
import { PastePanel } from "../connect/PastePanel";
import { SPECS } from "../connect/specs";
import { ConnectAll } from "../connect/ConnectAll";

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
/** Tool states on the shared status vocabulary (docs/DESIGN.md "Status"). */
const STATUS_OF: Record<State, UiStatus> = {
  connected: "ok",
  installed: "degraded",
  missing: "none",
  guide: "ready",
  unknown: "paused",
};

function stateOf(t: Tool, s: Status | undefined): State {
  if (t.configType === "guide") return "guide";
  if (!s) return "unknown";
  if (!s.installed) return "missing";
  return s.hasRegent ? "connected" : "installed";
}

function ToolIcon({ t, size }: { t: Tool; size: number }) {
  return (
    <ProviderLogo
      src={t.image}
      name={t.name}
      size={size}
      fallbackText={t.name.slice(0, 2)}
      className="shrink-0"
    />
  );
}

export function CliToolsWorkbench() {
  const params = useSearchParams();
  const router = useRouter();
  const sel = params.get("tool");
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState<Record<string, Status> | null>(null);
  const [connectAll, setConnectAll] = useState(false);

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
    router.replace(
      id ? `/dashboard/cli-tools?tool=${encodeURIComponent(id)}` : "/dashboard/cli-tools",
      { scroll: false },
    );

  const tool = TOOLS.find((t) => t.id === sel);
  const selId = tool ? tool.id : null;
  const state = tool ? stateOf(tool, statuses?.[tool.id]) : null;
  const filter = (t: Tool) => !q || t.name.toLowerCase().includes(q.toLowerCase());
  // Installed, not connected, and simple enough for the shared panel to configure.
  const connectable = statuses
    ? TOOLS.filter((t) => SPECS[t.id] && stateOf(t, statuses[t.id]) === "installed")
    : [];
  const groups = statuses
    ? GROUPS.map((g) => ({
        ...g,
        items: TOOLS.filter((t) => filter(t) && stateOf(t, statuses[t.id]) === g.state),
      })).filter((g) => g.items.length > 0)
    : [];
  const mitm = MITM.filter(filter);
  const order = groups.flatMap((g) => g.items.map((t) => t.id));
  const connected = statuses
    ? TOOLS.filter((t) => stateOf(t, statuses[t.id]) === "connected").length
    : 0;

  useListKeyboard({ order, selected: selId, onSelect: select, searchRef });

  return (
    <div className="flex min-h-0 flex-1">
      <WorkbenchList
        selected={selId}
        hints={[
          ["↑↓", "move"],
          ["/", "search"],
          ["esc", "overview"],
        ]}
        header={
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchInput
                ref={searchRef}
                placeholder="Search tools"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                shortcut="/"
              />
            </div>
            {connectable.length > 1 && (
              <Button size="sm" onClick={() => setConnectAll(true)}>
                Connect all
              </Button>
            )}
          </div>
        }
      >
        {!statuses ? (
          <ListSkeleton />
        ) : (
          <>
            {groups.map((g) => (
              <ListGroup key={g.state} title={g.label} count={g.items.length}>
                {g.items.map((t) => (
                  <ListRow
                    key={t.id}
                    id={t.id}
                    active={t.id === selId}
                    onClick={() => select(t.id === selId ? null : t.id)}
                    leading={<ToolIcon t={t} size={22} />}
                    title={t.name}
                    trailing={<StatusDot status={STATUS_OF[g.state]} />}
                    version={g.state}
                  />
                ))}
              </ListGroup>
            ))}
            {mitm.length > 0 && (
              <ListGroup title="Through a local intercept (MITM)" count={mitm.length}>
                {mitm.map((t) => (
                  <ListRow
                    key={t.id}
                    onClick={() => router.push("/dashboard/mitm")}
                    leading={<ToolIcon t={t} size={22} />}
                    title={t.name}
                    trailing={
                      <Icon name="arrow_outward" size={14} className="text-text-subtle" />
                    }
                  />
                ))}
              </ListGroup>
            )}
            {order.length === 0 && mitm.length === 0 && q && (
              <div className="py-10 text-center text-text-muted">Nothing matches “{q}”.</div>
            )}
          </>
        )}
      </WorkbenchList>

      <WorkbenchDetail selected={!!tool} backLabel="All CLI tools" onBack={() => select(null)}>
        {tool && state ? (
          <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8 md:py-8">
            <header className="flex items-start gap-4">
              <ToolIcon t={tool} size={56} />
              <div className="min-w-0">
                <h1 className="font-display text-3xl">{tool.name}</h1>
                <div className="mt-1">
                  {statuses ? (
                    <StatusLabel status={STATUS_OF[state]} label={LABEL[state]} />
                  ) : (
                    <StatusLabel status="pending" />
                  )}
                </div>
                {tool.description && (
                  <p className="mt-1 text-[13px] text-text-muted">{tool.description}</p>
                )}
              </div>
            </header>
            {tool.configType === "guide" ? (
              <PastePanel key={tool.id} toolId={tool.id} />
            ) : SPECS[tool.id] ? (
              <ConnectPanel
                key={tool.id}
                toolId={tool.id}
                toolName={tool.name}
                onChanged={() => void load()}
              />
            ) : (
              <ToolDetailClient
                key={tool.id}
                toolId={tool.id}
                embedded
                onWrite={() => void load()}
              />
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 md:px-8 md:py-8">
            <div>
              <h1 className="font-display text-3xl">CLI Tools</h1>
              <p className="mt-1 text-[13px] text-text-muted">
                {statuses ? (
                  <>
                    <strong className="font-medium text-text">
                      {connected} of {TOOLS.length} tools
                    </strong>{" "}
                    point at regent
                    {connectable.length > 0 &&
                      ` · ${connectable.length} installed but not connected`}
                  </>
                ) : (
                  "Checking which tools are installed…"
                )}
              </p>
            </div>
            <EmptyState icon="terminal">
              Pick a tool to point it at regent. Each one keeps its settings in its own config
              file; this writes them for you and keeps a backup.
            </EmptyState>
          </div>
        )}
      </WorkbenchDetail>
      {connectAll && (
        <ConnectAll
          tools={connectable}
          onClose={() => setConnectAll(false)}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}
