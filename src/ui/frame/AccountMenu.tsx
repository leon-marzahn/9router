"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import ChangelogModal from "@/shared/components/ChangelogModal";
import DonateModal from "@/shared/components/DonateModal";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import { ConfirmModal } from "@/shared/components/Modal";
import { APP_CONFIG } from "@/shared/constants/config";
import { Icon } from "../Icon";
import { Popover, MenuItem, MenuSeparator } from "../Popover";
import { cn } from "../cn";
import { RailTooltip } from "./Tooltip";
import { EXTERNAL_LINKS, SETTINGS_HREF } from "./nav";
import { logout, type AuthInfo } from "./useFrameData";

type Modal = null | "changelog" | "donate" | "language" | "shutdown";

/** Everything that used to live in the header's right side, behind one rail button. */
export function AccountMenu({
  auth,
  active,
  side = "right",
}: {
  auth: AuthInfo;
  active: boolean;
  side?: "right" | "bottom-end";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [shuttingDown, setShuttingDown] = useState(false);
  const sso = auth.displayName && (auth.loginMethod === "OIDC" || auth.loginMethod === "SAML");
  const openModal = (m: Modal) => {
    setOpen(false);
    setModal(m);
  };

  return (
    <>
      <RailTooltip label="Settings & account">
        <button
          ref={ref}
          type="button"
          aria-label="Settings & account"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "grid size-9 place-items-center rounded-lg transition-colors",
            active || open
              ? "bg-surface text-accent shadow-sm ring-1 ring-border dark:bg-surface-2 dark:ring-0"
              : "text-text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <Icon name="settings" size={19} filled={active} />
        </button>
      </RailTooltip>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        side={side}
        className="w-60"
      >
        <div className="px-3 pb-2 pt-1.5">
          <div className="text-xs font-medium">{APP_CONFIG.name}</div>
          <div className="font-mono text-[11px] text-text-muted">v{APP_CONFIG.version}</div>
          {sso && (
            <div
              className="mt-1.5 flex items-center gap-1.5 text-xs text-text-muted"
              title={auth.displayName}
            >
              <Icon name="person" size={14} className="text-accent" />
              <span className="truncate">{auth.displayName}</span>
              <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold text-accent-text">
                {auth.loginMethod}
              </span>
            </div>
          )}
        </div>
        <MenuSeparator />
        <Link
          href={SETTINGS_HREF}
          onClick={() => setOpen(false)}
          className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-2"
        >
          <Icon name="tune" size={18} className="text-text-muted" /> Settings
        </Link>
        <MenuItem icon="language" onClick={() => openModal("language")}>
          Language
        </MenuItem>
        <MenuItem icon="history" onClick={() => openModal("changelog")}>
          Changelog
        </MenuItem>
        <MenuItem icon="volunteer_activism" onClick={() => openModal("donate")}>
          Donate
        </MenuItem>
        <MenuSeparator />
        {EXTERNAL_LINKS.map((l) => (
          <MenuItem
            key={l.href}
            icon={l.icon}
            href={l.href}
            external
            onClick={() => setOpen(false)}
          >
            {l.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon="power_settings_new" danger onClick={() => openModal("shutdown")}>
          Shut down server
        </MenuItem>
        <MenuItem
          icon="logout"
          danger
          onClick={() => {
            setOpen(false);
            void logout();
          }}
        >
          Log out
        </MenuItem>
      </Popover>

      <ChangelogModal isOpen={modal === "changelog"} onClose={() => setModal(null)} />
      <DonateModal isOpen={modal === "donate"} onClose={() => setModal(null)} />
      <LanguageSwitcher hideTrigger isOpen={modal === "language"} onClose={() => setModal(null)} />
      <ConfirmModal
        isOpen={modal === "shutdown"}
        onClose={() => setModal(null)}
        onConfirm={async () => {
          setShuttingDown(true);
          // Expected to fail as the server goes away
          await fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
          setShuttingDown(false);
          setModal(null);
        }}
        title="Shut down server"
        message="Stop the 9Router server? Routing stops until you start it again."
        confirmText="Shut down"
        cancelText="Cancel"
        variant="danger"
        loading={shuttingDown}
      />
    </>
  );
}
