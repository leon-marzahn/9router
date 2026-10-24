// Token Saver: switches that make requests and answers shorter, so they cost
// fewer tokens. Settings-style page (same SectionCard/Row parts as Settings).
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button, CodeBlock, CopyButton, Icon, Input, Segmented, Switch, Tag, Textarea } from "@/ui";
import { cn } from "@/ui/cn";
import { ConfirmDialog } from "@/ui";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { Note, SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import { notify, useSettings, type Settings } from "../profile/settings/useSettings";
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS, WENYAN_LOCALES, type Level } from "./levels";

const DEFAULT_URL = "http://localhost:8787";
const DEFAULT_TIMEOUT = 3000;
const PIP_INSTALL = `pip install "headroom-ai[proxy]"`;

type Extra = "code" | "ml";
const EXTRAS: Record<Extra, { title: string; hint: string; setting: string }> = {
  code: {
    title: "Code-aware compression",
    hint: "Understands code structure (Python, JS/TS, Go, Rust, Java, C/C++, Perl) and shortens it without breaking it.",
    setting: "headroomCodeAware",
  },
  ml: {
    title: "Model-based compression",
    hint: "Uses a small local AI model (Kompress) to shorten prose and agent traces. Downloads about 1 GB.",
    setting: "headroomKompress",
  },
};

type HeadroomStatus = {
  loading: boolean;
  installed?: boolean;
  running?: boolean;
  python?: string | null;
  localUrl?: boolean;
  canStart?: boolean;
  managedPid?: number | null;
  error?: string;
};
type ExtrasStatus = { version: string | null; extras: Partial<Record<Extra, boolean>> };
type Confirm = {
  title: string;
  message: string;
  confirmText: string;
  variant: "primary" | "danger";
  run: () => void;
};

async function call(url: string, method = "POST", body?: unknown) {
  const res = await fetch(
    url,
    body
      ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method, cache: "no-store" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] font-normal text-text-subtle hover:text-text relative after:absolute after:-inset-x-1 after:-inset-y-3.5"
    >
      {children}
      <Icon name="open_in_new" size={11} />
    </a>
  );
}

function useLocale(): string {
  return useSyncExternalStore(onLocaleChange, getCurrentLocale, () => "en");
}

export function TokenSaver() {
  const api = useSettings();
  const s = api.settings;
  // Switches flip immediately; a failed save drops the override (and useSettings toasts).
  const [pending, setPending] = useState<Settings>({});
  const value = (k: string) => (k in pending ? pending[k] : s?.[k]);
  const set = useCallback(
    async (patch: Settings) => {
      setPending((p) => ({ ...p, ...patch }));
      try {
        await api.save(patch);
      } catch {
        /* toast already shown */
      } finally {
        setPending((p) => {
          const next = { ...p };
          for (const k of Object.keys(patch)) delete next[k];
          return next;
        });
      }
    },
    [api],
  );

  const locale = useLocale();
  const wenyan = WENYAN_LOCALES.includes(locale);
  const cavemanLevel: string = value("cavemanLevel") || "full";
  // Classical-Chinese levels only make sense in Chinese; fall back once if the language changed.
  useEffect(() => {
    if (!s) return;
    if (wenyan || !CAVEMAN_LEVELS.find((l) => l.id === cavemanLevel)?.wenyan) return;
    const t = setTimeout(() => void set({ cavemanLevel: "ultra" }), 0);
    return () => clearTimeout(t);
  }, [s, wenyan, cavemanLevel, set]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Token saver</h1>
        <p className="mt-1 text-sm text-text-muted">
          Make requests and answers shorter so they cost fewer tokens. Each switch applies to every
          chat request through the gateway, right away. A client can skip them for one request by
          sending <code className="font-mono text-xs text-text">X-Regent-Token-Saver: off</code>.
        </p>
      </div>

      <SettingsSection id="requests" icon="input" title="Shorter requests">
        {!s ? (
          <>
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </>
        ) : (
          <>
            <SettingRow
              title={
                <>
                  Shrink tool output
                  <Source href="https://github.com/rtk-ai/rtk">RTK</Source>
                </>
              }
              hint="Trims long command output your agent sends back (git, grep, ls, tree, logs) before it reaches the model. Usually 60–90% fewer input tokens. Errors are left as they are."
            >
              <Switch
                label="Shrink tool output"
                checked={value("rtkEnabled") !== false}
                onChange={(v) => set({ rtkEnabled: v })}
              />
            </SettingRow>
            <SettingRow
              title={
                <>
                  Compress the whole conversation
                  <Source href="https://github.com/chopratejas/headroom">Headroom</Source>
                </>
              }
              hint="Sends each request through a Headroom server first, which shortens it before it goes to the model. Needs a running Headroom server (set up below)."
            >
              <Switch
                label="Compress the whole conversation"
                checked={!!value("headroomEnabled")}
                onChange={(v) =>
                  set({ headroomEnabled: v, headroomUrl: s.headroomUrl || DEFAULT_URL })
                }
              />
            </SettingRow>
          </>
        )}
      </SettingsSection>

      {s && <Headroom settings={s} set={set} value={value} />}

      <SettingsSection id="answers" icon="short_text" title="Shorter answers">
        {!s ? (
          <>
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </>
        ) : (
          <>
            <StyleRow
              title={
                <>
                  Terse answers
                  <Source href="https://github.com/JuliusBrussee/caveman">Caveman</Source>
                </>
              }
              hint="Tells the model to answer in as few words as it can. About 65% fewer output tokens, up to 87%."
              enabled={!!value("cavemanEnabled")}
              onEnabled={(v) => set({ cavemanEnabled: v })}
              levels={CAVEMAN_LEVELS.filter((l) => wenyan || !l.wenyan)}
              level={cavemanLevel}
              onLevel={(id) => set({ cavemanLevel: id })}
            />
            <StyleRow
              title={
                <>
                  Minimal code
                  <Source href="https://github.com/DietrichGebert/ponytail">Ponytail</Source>
                </>
              }
              hint="Tells the model to write the least code that works: reuse what exists, skip what isn't needed yet, delete rather than add."
              enabled={!!value("ponytailEnabled")}
              onEnabled={(v) => set({ ponytailEnabled: v })}
              levels={PONYTAIL_LEVELS}
              level={value("ponytailLevel") || "full"}
              onLevel={(id) => set({ ponytailLevel: id })}
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection id="custom-prompt" icon="edit_note" title="Your own instruction">
        {!s ? (
          <SettingRowSkeleton />
        ) : (
          <CustomPrompt
            enabled={!!value("customPromptEnabled")}
            onEnabled={(v) => set({ customPromptEnabled: v })}
            saved={typeof s.customPrompt === "string" ? s.customPrompt : ""}
            onSave={(text) => set({ customPrompt: text })}
          />
        )}
      </SettingsSection>
    </div>
  );
}

const CUSTOM_PROMPT_MAX = 8000;

function CustomPrompt({
  enabled,
  onEnabled,
  saved,
  onSave,
}: {
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  saved: string;
  onSave: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const tooLong = text.length > CUSTOM_PROMPT_MAX;
  const save = async () => {
    setSaving(true);
    await onSave(text);
    setSaving(false);
  };
  return (
    <div>
      <SettingRow
        title="Custom system prompt"
        hint="Adds your text to the system prompt of every chat request, for every API key, alongside the savers above. House style, a language, a coding convention. Logs record only its length."
      >
        <Switch label="Custom system prompt" checked={enabled} onChange={onEnabled} />
      </SettingRow>
      {enabled && (
        <div className="-mt-1 space-y-2 pb-4">
          <Textarea
            aria-label="Custom system prompt text"
            rows={5}
            value={text}
            placeholder="Answer in British English. Prefer small, focused functions."
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className={cn(
                "text-[12px] tabular-nums",
                tooLong ? "text-danger-text" : "text-text-muted",
              )}
            >
              {text.trim()
                ? `${text.length.toLocaleString()} / ${CUSTOM_PROMPT_MAX.toLocaleString()} characters`
                : "Empty: nothing is added until you write something."}
            </span>
            <span className="flex gap-1">
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              )}
              <Button
                size="sm"
                icon="save"
                loading={saving}
                disabled={!dirty || tooLong}
                onClick={() => void save()}
              >
                Save
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function StyleRow({
  title,
  hint,
  enabled,
  onEnabled,
  levels,
  level,
  onLevel,
}: {
  title: ReactNode;
  hint: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  levels: Level[];
  level: string;
  onLevel: (id: string) => void;
}) {
  const label = typeof title === "string" ? title : "Enabled";
  // Segmented holds up to 4; the Chinese variants get their own row.
  const groups = [levels.filter((l) => !l.wenyan), levels.filter((l) => l.wenyan)].filter(
    (g) => g.length,
  );
  return (
    <div>
      <SettingRow title={title} hint={hint}>
        <Switch label={label} checked={enabled} onChange={onEnabled} />
      </SettingRow>
      {enabled && (
        <div className="-mt-1 space-y-1.5 pb-4">
          {groups.map((g, i) => (
            <Segmented
              key={i}
              value={level}
              onChange={onLevel}
              options={g.map((l) => ({ value: l.id, label: l.label }))}
              className="w-full max-w-sm"
            />
          ))}
          <p className="text-[12px] text-text-muted">{levels.find((l) => l.id === level)?.desc}</p>
        </div>
      )}
    </div>
  );
}

function Headroom({
  settings,
  set,
  value,
}: {
  settings: Settings;
  set: (p: Settings) => Promise<void>;
  value: (k: string) => any;
}) {
  const [status, setStatus] = useState<HeadroomStatus>({ loading: true });
  const [extras, setExtras] = useState<ExtrasStatus>({ version: null, extras: {} });
  const [url, setUrl] = useState<string>(settings.headroomUrl || DEFAULT_URL);
  const [timeout, setTimeoutMs] = useState<string>(
    String(settings.headroomTimeoutMs ?? DEFAULT_TIMEOUT),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const logTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setStatus((x) => ({ ...x, loading: true }));
    try {
      const st = await call("/api/headroom/status", "GET");
      setStatus({ ...st, loading: false });
      if (!st.installed) return setExtras({ version: null, extras: {} });
      try {
        const ex = await call("/api/headroom/extras", "GET");
        setExtras({ version: ex.version ?? null, extras: ex.extras || {} });
      } catch {
        setExtras({ version: null, extras: {} });
      }
    } catch (e) {
      setStatus({ loading: false, error: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  const stopLog = () => {
    if (logTimer.current) clearInterval(logTimer.current);
    logTimer.current = null;
  };
  useEffect(() => stopLog, []);
  const startLog = () => {
    setLog("");
    stopLog();
    const tick = async () => {
      try {
        const d = await call("/api/headroom/extras?log=1", "GET");
        if (typeof d.log === "string") setLog(d.log);
      } catch {
        /* transient; the next tick retries */
      }
    };
    void tick();
    logTimer.current = setInterval(tick, 1500);
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const start = () =>
    act("start", async () => {
      await call("/api/headroom/start");
      await refresh();
    });
  const stop = () =>
    act("stop", async () => {
      await call("/api/headroom/stop");
      await refresh();
    });

  const install = (extra: Extra) =>
    act(`install-${extra}`, async () => {
      startLog();
      try {
        const d = await call("/api/headroom/extras", "POST", { extras: [extra] });
        setExtras((x) => ({ version: d.version ?? x.version, extras: d.extras || x.extras }));
        notify().success(`Installed ${EXTRAS[extra].title.toLowerCase()}`);
      } finally {
        stopLog();
      }
    });
  const uninstall = (extra: Extra) =>
    act(`remove-${extra}`, async () => {
      startLog();
      try {
        const d = await call("/api/headroom/extras", "DELETE", { extras: [extra] });
        setExtras((x) => ({ version: d.version ?? x.version, extras: d.extras || x.extras }));
      } finally {
        stopLog();
      }
    });

  // The flags are passed when the server starts, so a running one is restarted.
  const toggleExtra = (extra: Extra, on: boolean) =>
    act(`toggle-${extra}`, async () => {
      await set({ [EXTRAS[extra].setting]: on });
      if (!status.running) return;
      await call("/api/headroom/restart");
      await refresh();
    });

  const saveUrl = async () => {
    const next = url.trim() || DEFAULT_URL;
    setUrl(next);
    if (next !== settings.headroomUrl) await set({ headroomUrl: next });
    await refresh();
  };
  const saveTimeout = () => {
    const n = Math.round(Number(timeout));
    const next = Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT;
    setTimeoutMs(String(next));
    if (next !== settings.headroomTimeoutMs) void set({ headroomTimeoutMs: next });
  };

  const local = status.localUrl !== false;
  const managed = local && !!status.managedPid;
  const label = status.loading
    ? "Checking…"
    : status.error
      ? "Couldn't check"
      : status.running
        ? "Running"
        : !local
          ? "Not reachable"
          : !status.installed
            ? "Not installed"
            : "Stopped";
  const tone = status.loading ? "neutral" : status.running ? "success" : "warning";
  const isOn = (x: Extra) =>
    x === "code" ? value(EXTRAS.code.setting) === true : value(EXTRAS.ml.setting) !== false;

  return (
    <>
      <SettingsSection id="headroom" icon="dns" title="Headroom server">
        <SettingRow
          title="Status"
          hint={
            status.error ??
            (status.running
              ? "Reachable. Requests are compressed while the switch above is on."
              : !local
                ? "This address isn't on this machine, so start Headroom there, then check again."
                : !status.installed && !status.python
                  ? "Running Headroom here needs Python 3.10 or newer. Install Python, or point the address at a Headroom server elsewhere."
                  : !status.installed
                    ? "Install it with the command below, then start it here."
                    : "Installed but not running.")
          }
        >
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Tag tone={tone}>{label}</Tag>
            <Button icon="refresh" onClick={() => void refresh()} disabled={status.loading}>
              Check again
            </Button>
            {managed ? (
              <Button icon="stop" onClick={stop} loading={busy === "stop"}>
                Stop
              </Button>
            ) : (
              !status.running &&
              status.canStart && (
                <Button
                  variant="primary"
                  icon="play_arrow"
                  onClick={start}
                  loading={busy === "start"}
                >
                  Start
                </Button>
              )
            )}
            {status.running && (
              <a
                href="/api/headroom/proxy/dashboard"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                Headroom dashboard
                <Icon name="open_in_new" size={14} />
              </a>
            )}
          </div>
        </SettingRow>

        {local && !status.loading && !status.installed && !!status.python && (
          <SettingRow
            title="Install"
            hint="Run this in a terminal on this machine, then press Check again."
          >
            <div className="flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]">
              <code className="min-w-0 flex-1 break-all">{PIP_INSTALL}</code>
              <CopyButton value={PIP_INSTALL} />
            </div>
          </SettingRow>
        )}

        {error && (
          <div className="py-3">
            <Note tone="danger">{error}</Note>
          </div>
        )}

        <SettingRow
          title="Address"
          hint="Where the Headroom server listens. A local address can be started and stopped here; for a separate server (for example a Docker sidecar like http://headroom:8787), start it yourself."
          stack
        >
          <Input
            mono
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void saveUrl()}
            placeholder={DEFAULT_URL}
            aria-label="Headroom address"
            className="max-w-md"
          />
        </SettingRow>
        <SettingRow
          title="Time limit"
          hint="How long to wait for Headroom, in milliseconds, before sending the request uncompressed."
        >
          <Input
            type="number"
            min={1}
            value={timeout}
            onChange={(e) => setTimeoutMs(e.target.value)}
            onBlur={saveTimeout}
            aria-label="Headroom time limit in milliseconds"
            className="w-32 tabular-nums"
          />
        </SettingRow>

        {status.installed &&
          (Object.keys(EXTRAS) as Extra[]).map((x) => {
            const installed = !!extras.extras[x];
            return (
              <SettingRow
                key={x}
                title={
                  <>
                    {EXTRAS[x].title}
                    {!installed && (
                      <Tag className="ml-2" tone="neutral">
                        Not installed
                      </Tag>
                    )}
                  </>
                }
                hint={
                  <>
                    {EXTRAS[x].hint}
                    {installed && status.running && " Switching restarts the Headroom server."}
                  </>
                }
              >
                {installed ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setConfirm({
                          title: `Uninstall ${EXTRAS[x].title.toLowerCase()}?`,
                          message: `This removes the [${x}] packages from the Headroom install.`,
                          confirmText: "Uninstall",
                          variant: "danger",
                          run: () => void uninstall(x),
                        })
                      }
                      loading={busy === `remove-${x}`}
                      disabled={busy != null && busy !== `remove-${x}`}
                    >
                      Uninstall
                    </Button>
                    <Switch
                      label={EXTRAS[x].title}
                      checked={isOn(x)}
                      disabled={busy != null}
                      onChange={(v) => void toggleExtra(x, v)}
                    />
                  </div>
                ) : (
                  <Button
                    icon="download"
                    loading={busy === `install-${x}`}
                    disabled={busy != null && busy !== `install-${x}`}
                    onClick={() =>
                      x === "ml"
                        ? setConfirm({
                            title: "Download about 1 GB?",
                            message:
                              "Model-based compression installs torch and huggingface-hub, about 1 GB. Continue?",
                            confirmText: "Install",
                            variant: "primary",
                            run: () => void install(x),
                          })
                        : void install(x)
                    }
                  >
                    Install
                  </Button>
                )}
              </SettingRow>
            );
          })}

        {busy?.match(/^(install|remove)-/) && log && (
          <div className="py-3">
            <CodeBlock text={log} wrap preClassName="max-h-40 text-[11px]" />
          </div>
        )}
        {status.installed && extras.version && (
          <p className="py-3 text-[11px] text-text-subtle">Headroom v{extras.version}</p>
        )}
      </SettingsSection>
      {/* Outside the card: its (hidden) wrapper would get a divider line from divide-y. */}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          run?.();
        }}
        title={confirm?.title}
        message={confirm?.message}
        confirmText={confirm?.confirmText}
        variant={confirm?.variant}
      />
    </>
  );
}
