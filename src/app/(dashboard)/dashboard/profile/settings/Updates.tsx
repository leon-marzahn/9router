"use client";

import { useState } from "react";
import { Button, Field, Input, Segmented } from "@/ui";
import { useUpdate, type HookResult, type UpdateInfo } from "@/ui/frame/useUpdate";
import { Note, SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import { notify } from "./useSettings";

async function send(path: string, init: RequestInit) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't save");
  return data;
}

function describe(r: HookResult) {
  const when = new Date(r.at).toLocaleString();
  const what = r.test ? "Test" : `v${r.version}`;
  return r.ok ? `${what}: accepted (${r.status}) · ${when}` : `${what}: ${r.error} · ${when}`;
}

/** Settings → Updates: the optional redeploy hook. Its URL is write-only. */
export function Updates() {
  const { info, setInfo } = useUpdate();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const hook = info?.webhook;

  const patch = async (body: object, mode: "save" | "remove" | null = null) => {
    setBusy(mode);
    try {
      const data = await send("/api/settings/updates", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setInfo((i) => (i ? { ...i, webhook: data.webhook } : i));
      return true;
    } catch (e) {
      notify().error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const { result } = await send("/api/settings/updates/test", { method: "POST" });
      setInfo((i: UpdateInfo | null) =>
        i ? { ...i, webhook: { ...i.webhook, lastResult: result } } : i,
      );
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection id="updates" icon="update" title="Updates">
      {!info || !hook ? (
        <SettingRowSkeleton />
      ) : (
        <>
          <SettingRow
            stack
            title="Redeploy hook"
            hint="Optional. Paste the deploy webhook from your hosting platform (Coolify, Portainer, CapRover, Dokploy…). When a newer release comes out, it's called once so the platform pulls the new image. Nothing else is sent."
          >
            <div className="space-y-3">
              {hook.set && (
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
                  <span>
                    Calls <code className="font-mono text-text">{hook.host}</code>
                  </span>
                  <Button
                    size="sm"
                    icon="send"
                    loading={busy === "test"}
                    onClick={() => void test()}
                  >
                    Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="delete"
                    loading={busy === "remove"}
                    onClick={() => void patch({ url: "" }, "remove")}
                  >
                    Remove
                  </Button>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label={hook.set ? "Replace with" : "Deploy hook URL"}
                  hint="https only (plain http works for local network addresses)."
                >
                  <Input
                    type="url"
                    value={url}
                    autoComplete="off"
                    placeholder="https://coolify.example.com/api/v1/deploy?uuid=…"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
                <Field
                  label="API token (optional)"
                  hint={
                    hook.hasToken
                      ? "A token is saved. Sent as a Bearer header."
                      : "Sent as a Bearer header, for platforms like Coolify that need one."
                  }
                >
                  <Input
                    type="password"
                    value={token}
                    autoComplete="off"
                    placeholder={hook.hasToken ? "••••••••" : ""}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <Button
                    size="sm"
                    variant="primary"
                    icon="check"
                    disabled={!url.trim() && !(hook.set && token.trim())}
                    loading={busy === "save"}
                    onClick={() =>
                      void patch(
                        url.trim()
                          ? { url: url.trim(), token: token.trim() }
                          : { token: token.trim() },
                        "save",
                      ).then((ok) => {
                        if (ok) {
                          setUrl("");
                          setToken("");
                          notify().success("Deploy hook saved");
                        }
                      })
                    }
                  >
                    Save
                  </Button>
                  <span className="text-[12px] text-text-muted">
                    Stored as secrets: never shown again and left out of backups.
                  </span>
                </div>
              </div>
              {hook.lastResult && (
                <Note tone={hook.lastResult.ok ? "success" : "danger"}>
                  Last call: {describe(hook.lastResult)}
                </Note>
              )}
            </div>
          </SettingRow>
          <SettingRow
            title="Follow"
            hint={
              hook.channel === "major"
                ? `Only releases in v${info.current.split(".")[0]}.x. A new major version can need manual steps, so you update to it yourself.`
                : "Every newer release, including new major versions."
            }
          >
            <Segmented
              value={hook.channel}
              onChange={(v) => void patch({ channel: v })}
              options={[
                { value: "major", label: "Same major" },
                { value: "any", label: "Any newer" },
              ]}
            />
          </SettingRow>
          {!info.checkEnabled && (
            <div className="py-3">
              <Note tone="warning">
                Update checks are off (<code className="font-mono">REGENT_UPDATE_CHECK=false</code>
                ), so the hook is never called.
              </Note>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}
