"use client";

import { useEffect, useState } from "react";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { ConfirmModal } from "@/shared/components/Modal";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { RailTooltip } from "./Tooltip";

const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

/**
 * Rail button that appears when a newer npm version exists, plus the manual
 * update flow: copy install command → server shuts down → user reinstalls.
 */
export function UpdateFlow() {
  const [latest, setLatest] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [disconnected, setDisconnected] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000) as { copied: string | null; copy: (t: string) => void };

  // Lazy version check after first render
  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/version")
        .then((r) => r.json())
        .then((d) => d.hasUpdate && setLatest(d.latestVersion))
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, []);

  const copyAndShutdown = () => {
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setDisconnected(true);
      }
    }, 1000);
  };

  if (!latest && !disconnected) return null;
  const counting = countdown > 0;

  return (
    <>
      {latest && (
        <RailTooltip label={`Update available: v${latest}`}>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            aria-label={`Update to v${latest}`}
            className="relative grid size-9 place-items-center rounded-lg text-success-text hover:bg-surface-2"
          >
            <Icon name="arrow_circle_up" size={20} />
            <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-success animate-live-ping" />
          </button>
        </RailTooltip>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          setPanelOpen(true);
        }}
        title="Update 9Router"
        message={`Show install command for v${latest || ""}? You can copy it and shut down to install manually.`}
        confirmText="Show command"
        cancelText="Cancel"
        variant="primary"
      />

      {(panelOpen || disconnected) && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-elev">
            <div className="mb-4 flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-accent-text">
                <Icon name={disconnected ? "power_off" : "system_update_alt"} size={24} />
              </div>
              <div>
                <h2 className="font-display text-xl">{disconnected ? "Server stopped" : `Update 9Router${latest ? ` to v${latest}` : ""}`}</h2>
                <p className="text-xs text-text-muted">
                  {disconnected
                    ? "Paste the command into a terminal to install, then start 9router again."
                    : counting
                      ? `Command copied. Server will stop in ${countdown}s…`
                      : "Copy the install command; the server then shuts down so it can be replaced."}
                </p>
              </div>
            </div>
            <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2">
              <code className="break-all font-mono text-xs text-accent-text">{INSTALL_CMD}</code>
            </div>
            <ol className="mb-5 list-inside list-decimal space-y-1 text-xs text-text-muted">
              <li>Click <b>Copy &amp; shut down</b>.</li>
              <li>Paste the command into your terminal and press Enter.</li>
              <li>Run <code className="rounded bg-surface-2 px-1">9router</code> again after install.</li>
            </ol>
            {disconnected ? (
              <Button className="w-full" onClick={() => globalThis.location.reload()}>Reload page</Button>
            ) : (
              <div className="flex gap-2">
                <Button onClick={() => { setPanelOpen(false); setCountdown(0); }} disabled={counting}>Cancel</Button>
                <Button variant="primary" className="flex-1" onClick={copyAndShutdown} disabled={counting}>
                  {copied ? "Copied — shutting down…" : counting ? `Shutting down in ${countdown}s` : "Copy & shut down"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
