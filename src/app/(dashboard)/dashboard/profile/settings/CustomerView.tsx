"use client";

import { useEffect, useState } from "react";
import { CopyButton, Switch } from "@/ui";
import { SettingRow, SettingRowSkeleton, SettingsSection } from "@/ui";
import type { SettingsApi } from "./useSettings";

interface Key {
  id: string;
  name: string;
  isActive: boolean;
}

/** Settings → Customer view: lets key holders see their own usage at /customer. */
export function CustomerViewSettings({ api }: { api: SettingsApi }) {
  const s = api.settings;
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setOrigin(window.location.origin), 0);
    fetch("/api/keys", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d) =>
        setKeys((d.keys || []).map(({ id, name, isActive }: Key) => ({ id, name, isActive }))),
      )
      .catch(() => setKeys([]));
    return () => clearTimeout(t);
  }, []);
  const enabled = s?.customerViewEnabled === true;
  const blocked: string[] = Array.isArray(s?.customerViewBlockedKeys)
    ? s.customerViewBlockedKeys
    : [];
  const url = `${origin}/customer`;

  return (
    <SettingsSection id="customer-view" icon="person" title="Customer view">
      {!s ? (
        <SettingRowSkeleton />
      ) : (
        <>
          <SettingRow
            title="Let key holders see their usage"
            hint="A page where someone signs in with their own API key and sees only that key's spend, budget and recent requests. No prompts, providers or accounts are shown."
          >
            <Switch
              checked={enabled}
              label="Customer view"
              onChange={(v) => void api.save({ customerViewEnabled: v }).catch(() => {})}
            />
          </SettingRow>
          {enabled && (
            <SettingRow
              stack
              title="Share this link"
              hint="Customers paste their key on the page; it isn't put in the link."
            >
              <div className="flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]">
                <span className="min-w-0 flex-1 truncate">{url}</span>
                <CopyButton value={url} label="Copy link" />
              </div>
            </SettingRow>
          )}
          {enabled && !!keys?.length && (
            <SettingRow
              stack
              title="Keys allowed"
              hint="Turn a key off to keep its holder out of the customer view."
            >
              <div className="divide-y divide-border-subtle">
                {keys.map((k) => {
                  const on = !blocked.includes(k.id);
                  return (
                    <div
                      key={k.id}
                      className="flex items-center justify-between gap-3 py-2 text-[13px]"
                    >
                      <span className="min-w-0 truncate">
                        {k.name}
                        {!k.isActive && <span className="text-text-muted"> (inactive)</span>}
                      </span>
                      <Switch
                        checked={on}
                        label={`Customer view for ${k.name}`}
                        onChange={(v) =>
                          void api
                            .save({
                              customerViewBlockedKeys: v
                                ? blocked.filter((x) => x !== k.id)
                                : [...blocked, k.id],
                            })
                            .catch(() => {})
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </SettingRow>
          )}
        </>
      )}
    </SettingsSection>
  );
}
