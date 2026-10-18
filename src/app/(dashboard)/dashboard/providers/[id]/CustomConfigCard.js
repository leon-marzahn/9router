"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Icon, IconButton, Tag, cn, inputClass } from "@/ui";
import { useNotificationStore } from "@/store/notificationStore";

// Mirrors the server-side gate in /api/providers/[id]/overrides — client check is UX only
const BLOCKED_HEADERS = ["host", "content-length", "content-type", "connection", "transfer-encoding", "authorization", "cookie"];
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export default function CustomConfigCard({ providerId }) {
  const notify = useNotificationStore();
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState([{ name: "", value: "" }]);
  const [builtin, setBuiltin] = useState({});
  const [hasOverride, setHasOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/providers/${providerId}/overrides`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Effective set = registry built-ins with user overrides layered on top
        const builtinHeaders = data.builtinHeaders || {};
        const effective = { ...builtinHeaders, ...(data.headers || {}) };
        const headerRows = Object.entries(effective).map(([name, value]) => ({ name, value }));
        setBuiltin(builtinHeaders);
        setRows(headerRows.length ? headerRows : [{ name: "", value: "" }]);
        setHasOverride(Object.keys(data.headers || {}).length > 0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const setRow = (i, field, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  };

  const save = useCallback(async () => {
    // Diff-on-save: only rows differing from the registry default become overrides,
    // so a code-side registry bump still wins for everything the user left alone.
    const headers = {};
    for (const r of rows.filter((r) => r.name.trim())) {
      const name = r.name.trim();
      if (!HEADER_NAME_RE.test(name)) {
        notify.error(`Invalid header name: ${name}`);
        return;
      }
      if (BLOCKED_HEADERS.includes(name.toLowerCase())) {
        notify.error(`Header ${name} cannot be overridden`);
        return;
      }
      if (name in headers) {
        notify.error(`Duplicate header name: ${name}`);
        return;
      }
      if (r.value !== builtin[name]) headers[name] = r.value;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${providerId}/overrides`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify.error(err.error || "Failed to save");
        return;
      }
      setHasOverride(Object.keys(headers).length > 0);
      notify.success("Custom headers saved");
    } finally {
      setSaving(false);
    }
  }, [rows, builtin, providerId, notify]);

  const resetToBuiltin = () => {
    setRows(Object.entries(builtin).map(([name, value]) => ({ name, value })));
  };

  // Only render when there is something to customize: registry headers or existing overrides
  if (Object.keys(builtin).length === 0 && !hasOverride) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-2/60"
      >
        <Icon name="tune" size={18} className="text-text-muted" />
        <span className="text-[13px] font-medium">Custom headers</span>
        {hasOverride && <Tag tone="success">active</Tag>}
        <Icon name={expanded ? "expand_less" : "expand_more"} size={18} className="ml-auto text-text-subtle" />
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => {
              const overridden = row.name.trim() in builtin && row.value !== builtin[row.name.trim()];
              return (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, "name", e.target.value)}
                    placeholder="Header-Name"
                    aria-label="Header name"
                    spellCheck={false}
                    className={cn(inputClass, "h-8 w-44 font-mono text-xs")}
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, "value", e.target.value)}
                    placeholder="Value"
                    aria-label="Header value"
                    spellCheck={false}
                    title={overridden ? "Overridden" : row.name.trim() in builtin ? "Registry default" : ""}
                    className={cn(inputClass, "h-8 min-w-0 flex-1 font-mono text-xs", overridden && "border-warning")}
                  />
                  <IconButton
                    icon="delete"
                    label="Remove header"
                    onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ name: "", value: "" }]))}
                    className="hover:bg-danger-soft hover:text-danger-text"
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="ghost" icon="add" onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}>
              Add header
            </Button>
            <div className="ml-auto flex gap-2">
              <Button disabled={saving} onClick={resetToBuiltin}>Reset</Button>
              <Button variant="primary" loading={saving} onClick={save}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

CustomConfigCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
