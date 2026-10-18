"use client";

import { useRef, useState } from "react";
import { Button, Field, Input, Segmented, Switch, Tag } from "@/ui";
import { ConfirmModal, Modal } from "@/shared/components";
import LanguageSwitcherJs from "@/shared/components/LanguageSwitcher";
import { useTheme as useThemeJs } from "@/shared/hooks/useTheme";
import { APP_CONFIG } from "@/shared/constants/config";
import { STOP_APP, stopApp } from "@/ui/frame/stopApp";
import { logout } from "@/ui/frame/useFrameData";
import { Note, Row, RowSkeleton, SectionCard } from "./parts";
import { notify, type SettingsApi } from "./useSettings";

const LanguageSwitcher = LanguageSwitcherJs as unknown as React.ComponentType<{
  hideTrigger?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
}>;
const useTheme = useThemeJs as unknown as () => {
  theme: "light" | "dark" | "system";
  setTheme: (t: string) => void;
};

export function Appearance() {
  const { theme, setTheme } = useTheme();
  const [lang, setLang] = useState(false);
  return (
    <>
      <SectionCard id="appearance" icon="palette" title="Appearance">
        <Row title="Theme">
          <Segmented
            value={theme ?? "system"}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>
        <Row
          title="Language"
          hint="Dashboard text only. Requests through the gateway aren't affected."
        >
          <Button size="sm" icon="translate" onClick={() => setLang(true)}>
            Change
          </Button>
        </Row>
      </SectionCard>
      {/* Outside the card: its (hidden) wrapper would get a divider line from divide-y. */}
      <LanguageSwitcher hideTrigger isOpen={lang} onClose={() => setLang(false)} />
    </>
  );
}

export function Routing({ api }: { api: SettingsApi }) {
  const s = api.settings;
  const accounts = s?.fallbackStrategy === "round-robin" ? "rr" : "fill";
  const combos = s?.comboStrategy === "round-robin" ? "rr" : "fallback";
  return (
    <SectionCard id="routing" icon="alt_route" title="Routing">
      {!s ? (
        <>
          <RowSkeleton />
          <RowSkeleton />
        </>
      ) : (
        <>
          <Row
            title="Accounts of one provider"
            hint={
              accounts === "fill"
                ? "Use the first account until it runs out or fails, then the next."
                : `Take turns: ${s.stickyRoundRobinLimit ?? 3} requests per account, then move on.`
            }
          >
            <Segmented
              value={accounts}
              onChange={(v) =>
                void api
                  .save({ fallbackStrategy: v === "rr" ? "round-robin" : "fill-first" })
                  .catch(() => {})
              }
              options={[
                { value: "fill", label: "Fill first" },
                { value: "rr", label: "Take turns" },
              ]}
            />
          </Row>
          {accounts === "rr" && (
            <Row
              title="Requests per turn"
              hint="Keeping a few in a row on one account helps prompt caching."
            >
              <NumberSave
                value={s.stickyRoundRobinLimit ?? 3}
                onSave={(n) => api.save({ stickyRoundRobinLimit: n })}
              />
            </Row>
          )}
          <Row
            title="Models in a combo"
            hint={
              combos === "fallback"
                ? "Try them in order and move on only when one fails."
                : `Take turns between the models: ${s.comboStickyRoundRobinLimit ?? 1} request${(s.comboStickyRoundRobinLimit ?? 1) === 1 ? "" : "s"} each.`
            }
          >
            <Segmented
              value={combos}
              onChange={(v) =>
                void api
                  .save({ comboStrategy: v === "rr" ? "round-robin" : "fallback" })
                  .catch(() => {})
              }
              options={[
                { value: "fallback", label: "In order" },
                { value: "rr", label: "Take turns" },
              ]}
            />
          </Row>
          {combos === "rr" && (
            <Row title="Requests per model">
              <NumberSave
                value={s.comboStickyRoundRobinLimit ?? 1}
                onSave={(n) => api.save({ comboStickyRoundRobinLimit: n })}
              />
            </Row>
          )}
        </>
      )}
    </SectionCard>
  );
}

function NumberSave({ value, onSave }: { value: number; onSave: (n: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(value));
  const n = parseInt(v, 10);
  const dirty = n !== value;
  return (
    <span className="flex items-center gap-2">
      <Input
        type="number"
        min={1}
        value={v}
        onChange={(e) => setV(e.target.value)}
        className="w-20"
      />
      {dirty && (
        <Button size="sm" disabled={!(n >= 1)} onClick={() => void onSave(n).catch(() => {})}>
          Save
        </Button>
      )}
    </span>
  );
}

export function Network({ api }: { api: SettingsApi }) {
  const s = api.settings;
  const [url, setUrl] = useState<string | null>(null);
  const [skip, setSkip] = useState<string | null>(null);
  const [test, setTest] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const proxyUrl = url ?? s?.outboundProxyUrl ?? "";
  const noProxy = skip ?? s?.outboundNoProxy ?? "";

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl: proxyUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setTest(
        res.ok && data.ok
          ? { tone: "success", text: `Works: answered ${data.status} in ${data.elapsedMs} ms` }
          : { tone: "danger", text: data.error || "The proxy didn't answer" },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard id="network" icon="lan" title="Network">
      {!s ? (
        <RowSkeleton />
      ) : (
        <>
          <Row
            title="Send provider traffic through a proxy"
            hint="For networks that block AI providers directly. Takes effect immediately."
          >
            <Switch
              checked={s.outboundProxyEnabled === true}
              onChange={(v) => void api.save({ outboundProxyEnabled: v }).catch(() => {})}
              label="Outbound proxy"
            />
          </Row>
          {s.outboundProxyEnabled === true && (
            <Row stack title="Proxy">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Proxy URL">
                  <Input
                    value={proxyUrl}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <Field label="Skip for" hint="Comma-separated hosts that go direct">
                  <Input
                    value={noProxy}
                    placeholder="localhost, 127.0.0.1"
                    onChange={(e) => setSkip(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button
                    size="sm"
                    icon="network_check"
                    loading={busy}
                    disabled={!proxyUrl.trim()}
                    onClick={() => void runTest()}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    icon="check"
                    onClick={() =>
                      void api
                        .save({
                          outboundProxyUrl: proxyUrl.trim(),
                          outboundNoProxy: noProxy.trim(),
                        })
                        .then(() => notify().success("Proxy saved"))
                        .catch(() => {})
                    }
                  >
                    Save
                  </Button>
                  {test && <Note tone={test.tone}>{test.text}</Note>}
                </div>
              </div>
            </Row>
          )}
        </>
      )}
    </SectionCard>
  );
}

const KEEP = [
  { value: "200", label: "200" },
  { value: "1000", label: "1,000" },
  { value: "5000", label: "5,000" },
];

export function RequestLogging({ api }: { api: SettingsApi }) {
  const s = api.settings;
  const envLocked = s?.requestLogsEnvOverride === true;
  const on = envLocked ? s?.enableRequestLogs === true : s?.enableObservability === true;
  const keep = String(s?.observabilityMaxRecords ?? 1000);
  return (
    <SectionCard id="request-logging" icon="receipt_long" title="Request logging">
      {!s ? (
        <RowSkeleton />
      ) : (
        <>
          <Row
            title="Save request and response bodies"
            hint={
              <>
                Lets you open a request on the Usage page and see exactly what was sent and what
                came back. Off, you still get tokens, cost and timing for every request, just not
                the content.
              </>
            }
          >
            <Switch
              checked={on}
              disabled={envLocked}
              onChange={(v) => void api.save({ enableObservability: v }).catch(() => {})}
              label="Save request bodies"
            />
          </Row>
          {envLocked && (
            <div className="py-3">
              <Note tone="warning">
                Set by <code className="font-mono">ENABLE_REQUEST_LOGS</code> when the app was
                started, so this switch can&rsquo;t change it. Remove the variable to control it
                here.
              </Note>
            </div>
          )}
          {on && (
            <>
              <Row title="Keep the last" hint="Older requests are deleted as new ones come in.">
                <Segmented
                  value={KEEP.some((k) => k.value === keep) ? keep : "1000"}
                  onChange={(v) =>
                    void api.save({ observabilityMaxRecords: Number(v) }).catch(() => {})
                  }
                  options={KEEP}
                />
              </Row>
              <Row
                title="What's saved"
                hint="Prompts and replies can contain anything you or your tools sent, including secrets pasted into a chat. They stay on this machine."
              >
                <span className="flex flex-wrap gap-1 sm:justify-end">
                  <Tag>Prompt</Tag>
                  <Tag>Reply</Tag>
                  <Tag>Headers</Tag>
                </span>
              </Row>
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}

export function Backup({ api }: { api: SettingsApi }) {
  const file = useRef<HTMLInputElement>(null);
  const pending = useRef<File | null>(null);
  const [ask, setAsk] = useState<null | "export" | "import">(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState<File | null>(null);

  const run = async () => {
    const mode = ask;
    const pw = password;
    setAsk(null);
    setPassword("");
    setBusy(true);
    try {
      if (mode === "export") {
        const res = await fetch("/api/settings/database", { headers: { "x-9r-password": pw } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't create the backup");
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
        );
        const a = Object.assign(document.createElement("a"), {
          href: url,
          download: `regent-backup-${new Date().toISOString().replace(/[.:]/g, "-")}.json`,
        });
        a.click();
        URL.revokeObjectURL(url);
        notify().success("Backup downloaded");
      } else if (mode === "import" && pending.current) {
        let payload: unknown;
        try {
          payload = JSON.parse(await pending.current.text());
        } catch {
          throw new Error("That file isn't a backup");
        }
        const res = await fetch("/api/settings/database", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(payload as object), password: pw }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't restore the backup");
        await api.reload();
        notify().success("Backup restored");
      }
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      pending.current = null;
      setBusy(false);
    }
  };

  return (
    <SectionCard id="backup" icon="save" title="Backup">
      <Row
        title="Download a backup"
        hint="Everything: providers, accounts, keys, combos and settings. It contains your secrets, so keep it safe."
      >
        <Button
          size="sm"
          icon="download"
          loading={busy && ask === null}
          onClick={() => setAsk("export")}
        >
          Download
        </Button>
      </Row>
      <Row
        title="Restore from a backup"
        hint="Replaces everything here with the file's contents. 9router backups work too."
      >
        <Button size="sm" icon="upload" onClick={() => file.current?.click()}>
          Restore
        </Button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) setRestoreConfirm(f);
          }}
        />
      </Row>
      <Row title="Stored in" hint="Set DATA_DIR when starting the app to keep it somewhere else.">
        <code className="font-mono text-[12px] text-text-muted">~/.regent/db/data.sqlite</code>
      </Row>

      <ConfirmModal
        isOpen={!!restoreConfirm}
        onClose={() => setRestoreConfirm(null)}
        title="Replace everything?"
        message={`Restoring ${restoreConfirm?.name ?? "this file"} replaces all providers, accounts, keys, combos and settings here. Download a backup first if you might want them back.`}
        confirmText="Restore"
        confirmIcon="upload"
        onConfirm={() => {
          pending.current = restoreConfirm;
          setRestoreConfirm(null);
          setAsk("import");
        }}
      />
      <Modal
        isOpen={!!ask}
        onClose={() => {
          setAsk(null);
          setPassword("");
        }}
        title="Confirm it's you"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={ask === "export" ? "download" : "upload"}
              disabled={!password}
              onClick={() => void run()}
            >
              {ask === "export" ? "Download" : "Restore"}
            </Button>
          </>
        }
      >
        <Field label="Dashboard password">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && void run()}
          />
        </Field>
      </Modal>
    </SectionCard>
  );
}

export function About() {
  const [stop, setStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = (APP_CONFIG as { forkedFrom?: { version: string } }).forkedFrom;
  return (
    <SectionCard id="about" icon="info" title="About">
      <Row
        title="Elizabeth's Proxy"
        hint={`v${APP_CONFIG.version}${base ? ` · based on 9router ${base.version}` : ""}`}
      >
        <Button
          size="sm"
          variant="ghost"
          icon="open_in_new"
          onClick={() =>
            window.open(
              "https://github.com/leon-marzahn/regent/releases",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          Release notes
        </Button>
      </Row>
      <Row title="Sign out" hint="Ends this dashboard session in this browser.">
        <Button size="sm" icon="logout" onClick={() => void logout()}>
          Sign out
        </Button>
      </Row>
      <Row
        title="Stop Elizabeth's Proxy"
        hint="Shuts down the gateway and this dashboard. Nothing can use it until you start it again."
      >
        <Button size="sm" variant="danger" icon="power_settings_new" onClick={() => setStop(true)}>
          Stop
        </Button>
      </Row>
      <ConfirmModal
        isOpen={stop}
        onClose={() => setStop(false)}
        loading={busy}
        title={STOP_APP.title}
        message={STOP_APP.message}
        confirmText={STOP_APP.confirm}
        confirmIcon="power_settings_new"
        onConfirm={async () => {
          setBusy(true);
          await stopApp();
          setBusy(false);
          setStop(false);
        }}
      />
    </SectionCard>
  );
}
