"use client";

import { useRef, useState } from "react";
import {
  Button,
  CopyButton,
  Icon,
  IconButton,
  MenuItem,
  Note,
  Popover,
  StatusLabel,
  Switch,
  Tag,
} from "@/ui";
import { PoolFields } from "./dialogs";
import {
  RELAY_LABEL,
  STATUS_TEXT,
  formatDateTime,
  poolStatus,
  toForm,
  type ProxyPool,
} from "./pools";
import type { ProxyPoolsApi } from "./useProxyPools";

export function PoolDetail({
  pool: p,
  api,
  onDeleted,
}: {
  pool: ProxyPool;
  api: ProxyPoolsApi;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(() => toForm(p));
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const status = poolStatus(p);
  const testing = api.testingId === p.id;
  const saved = toForm(p);
  // Active is toggled live from the header; the form only owns the other fields.
  const dirty =
    form.name !== saved.name ||
    form.proxyUrl !== saved.proxyUrl ||
    form.noProxy !== saved.noProxy ||
    form.strictProxy !== saved.strictProxy;

  const save = async () => {
    setSaving(true);
    await api.save({ ...form, isActive: p.isActive }, p.id);
    setSaving(false);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-7 px-4 py-6 md:px-8 md:py-8">
      <header className="flex items-start gap-4">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface">
          <Icon
            name={p.type && p.type !== "http" ? "rocket_launch" : "lan"}
            size={26}
            className="text-text-muted"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="truncate font-display text-3xl tracking-tight">{p.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
            <StatusLabel status={status} label={STATUS_TEXT[status]} />
            <Tag>{RELAY_LABEL[p.type ?? "http"]}</Tag>
            <Tag>{p.boundConnectionCount || 0} bound</Tag>
            {p.strictProxy && <Tag>strict</Tag>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            label={p.isActive ? "Disable" : "Enable"}
            checked={p.isActive}
            onChange={() => void api.toggleActive(p)}
          />
          <IconButton ref={menuRef} icon="more_horiz" label="More" onClick={() => setMenu(true)} />
          <Popover
            open={menu}
            onClose={() => setMenu(false)}
            anchorRef={menuRef}
            side="bottom-end"
            className="w-44 py-1"
          >
            <MenuItem
              icon="delete"
              danger
              onClick={() => {
                setMenu(false);
                api.remove(p, onDeleted);
              }}
            >
              Delete
            </MenuItem>
          </Popover>
        </div>
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-1 rounded-lg bg-bg-alt px-3 py-1.5 font-mono text-[12px]">
          <span className="min-w-0 flex-1 truncate">{p.proxyUrl}</span>
          <CopyButton value={p.proxyUrl} label="Copy proxy URL" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            icon="science"
            loading={testing}
            onClick={() => void api.test(p.id)}
          >
            Test
          </Button>
          <span className="text-[12px] text-text-muted">
            Last tested: {formatDateTime(p.lastTestedAt)}
          </span>
        </div>
        {p.lastError && status !== "ok" ? <Note tone="danger">{p.lastError}</Note> : null}
      </section>

      <section className="space-y-4">
        <PoolFields form={form} onChange={setForm} disabled={saving} hideActive />
        <div className="flex gap-2">
          <Button
            variant="primary"
            icon="save"
            loading={saving}
            disabled={!dirty || !form.name.trim() || !form.proxyUrl.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(saved)} disabled={saving}>
              Discard
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
