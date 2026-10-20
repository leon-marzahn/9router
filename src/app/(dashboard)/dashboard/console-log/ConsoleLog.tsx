// Console Log: the server's own console output, streamed live. Like the Usage
// feed, it holds still while you read: scrolling up pauses auto-follow and
// new lines queue behind a "N new lines" bar.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  CopyButton,
  EmptyState,
  Panel,
  SearchInput,
  Segmented,
  StatusDot,
  TopBarActions,
  TopBarContent,
} from "@/ui";
import { cn } from "@/ui/cn";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { notify } from "../profile/settings/useSettings";

const MAX = (CONSOLE_LOG_CONFIG as { maxLines: number }).maxLines;

type Level = "error" | "warn" | "info";
type Filter = "all" | "problems";

// The capture keeps only the text, not which console method wrote it, so the
// level is read from the line itself.
export function levelOf(line: string): Level {
  if (/\[(error|fatal)\]|\b(error|failed|exception|fatal)\b/i.test(line)) return "error";
  if (/\[warn(ing)?\]|\bwarn(ing)?\b|\bdeprecated\b/i.test(line)) return "warn";
  return "info";
}

const LEVEL_CLASS: Record<Level, string> = {
  error: "text-danger-text bg-danger/5",
  warn: "text-warning-text bg-warning/5",
  info: "text-text",
};

type Line = { id: number; text: string; level: Level };

function useConsoleStream() {
  const [lines, setLines] = useState<Line[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    const wrap = (text: string): Line => ({ id: seq.current++, text, level: levelOf(text) });
    const append = (texts: string[]) =>
      setLines((prev) => {
        const next = [...prev, ...texts.map(wrap)];
        return next.length > MAX ? next.slice(-MAX) : next;
      });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let msg: { type: string; logs?: string[]; line?: string; lines?: string[] };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "init") setLines((msg.logs ?? []).slice(-MAX).map(wrap));
      else if (msg.type === "line" && msg.line != null) append([msg.line]);
      else if (msg.type === "lines" && msg.lines) append(msg.lines);
      else if (msg.type === "clear") setLines([]);
    };
    return () => es.close();
  }, []);

  return { lines, connected };
}

export function ConsoleLog() {
  const { lines, connected } = useConsoleStream();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [seenId, setSeenId] = useState(-1);
  const [clearing, setClearing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const problems = useMemo(() => lines.filter((l) => l.level !== "info").length, [lines]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter(
      (l) => (filter === "all" || l.level !== "info") && (!q || l.text.toLowerCase().includes(q)),
    );
  }, [lines, filter, query]);

  const lastId = lines.length ? lines[lines.length - 1].id : -1;
  const unseen = following ? 0 : lines.filter((l) => l.id > seenId).length;

  useEffect(() => {
    const el = boxRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [shown, following]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== following) {
      setFollowing(atBottom);
      if (!atBottom) setSeenId(lastId);
    }
  };

  const jumpToLatest = () => {
    setFollowing(true);
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const clear = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!res.ok) throw new Error();
      // The stream sends a "clear" event that empties the view.
    } catch {
      notify().error("Couldn't clear the console log");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <TopBarContent>
        <span className="flex items-center gap-2 text-xs text-text-muted">
          <StatusDot status={connected ? "ok" : "error"} live={connected} />
          {connected ? "Live" : "Reconnecting…"}
          <span className="text-text-subtle">·</span>
          <b className="tabular-nums text-text">{lines.length}</b> lines
          {problems > 0 && (
            <>
              <span className="text-text-subtle">·</span>
              <span className="text-danger-text">
                <b className="tabular-nums">{problems}</b> errors or warnings
              </span>
            </>
          )}
        </span>
      </TopBarContent>
      <TopBarActions>
        {shown.length > 0 && (
          <CopyButton value={shown.map((l) => l.text).join("\n")} label="Copy shown lines" />
        )}
        <Button icon="delete" onClick={clear} loading={clearing} disabled={!lines.length}>
          Clear
        </Button>
      </TopBarActions>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Console log</h1>
          <p className="mt-1 text-sm text-text-muted">
            What the server prints while it runs, newest at the bottom. Keeps the last {MAX} lines;
            Clear empties it for everyone viewing.
          </p>
        </div>
        <div className="flex gap-2">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter lines"
            aria-label="Filter lines"
            className="min-w-0 flex-1 sm:w-56"
          />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "problems", label: "Problems" },
            ]}
            className="w-40 shrink-0 self-center"
          />
        </div>
      </div>

      <Panel className="relative overflow-hidden">
        <div
          ref={boxRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Console output"
          tabIndex={0}
          className="h-[calc(100dvh-260px)] min-h-64 overflow-y-auto bg-bg-alt py-2 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:shadow-focus"
        >
          {shown.length === 0 ? (
            <EmptyState icon="receipt_long" className="m-4">
              {lines.length === 0
                ? connected
                  ? "Nothing logged yet. Lines appear here as the server writes them."
                  : "Connecting to the server…"
                : "No lines match this filter."}
            </EmptyState>
          ) : (
            shown.map((l) => (
              <div
                key={l.id}
                className={cn(
                  "whitespace-pre-wrap break-all px-4 [overflow-wrap:anywhere]",
                  LEVEL_CLASS[l.level],
                )}
              >
                {l.text}
              </div>
            ))
          )}
        </div>
        {!following && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-inverse px-3 py-1.5 text-xs font-medium text-inverse-fg shadow-elev"
          >
            {unseen > 0 ? `${unseen} new line${unseen === 1 ? "" : "s"}` : "Paused"} · Jump to
            latest
          </button>
        )}
      </Panel>
    </div>
  );
}
