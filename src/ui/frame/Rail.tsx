"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "@/shared/hooks/useTheme";
import { Icon } from "../Icon";
import { Logo } from "../Logo";
import { cn } from "../cn";
import { RailTooltip } from "./Tooltip";
import { AccountMenu } from "./AccountMenu";
import { NAV, SETTINGS_HREF, isActive, type NavItem } from "./nav";
import type { AuthInfo } from "./useFrameData";

const itemClass = (active: boolean) =>
  cn(
    "grid size-9 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:shadow-focus",
    active
      ? "bg-surface text-accent shadow-sm ring-1 ring-border dark:bg-surface-2 dark:text-accent-text dark:ring-0"
      : "text-text-muted hover:bg-surface-2 hover:text-text",
  );

/** Slim icon navigation (md and up). Labels live in tooltips. */
export function Rail({ flags, auth }: { flags: { enableTranslator?: boolean }; auth: AuthInfo }) {
  const pathname = usePathname() ?? "";
  const { isDark, toggleTheme } = useTheme() as { isDark: boolean; toggleTheme: () => void };
  const visible = (i: NavItem) => !i.flag || flags[i.flag];

  return (
    <nav
      aria-label="Main"
      className="hidden w-14 shrink-0 flex-col items-center border-r border-border bg-bg-alt py-3 md:flex"
    >
      <Link
        href="/dashboard"
        aria-label="Elizabeth's Proxy home"
        className="mb-3 shrink-0 rounded-lg shadow-warm"
      >
        <Logo size={32} />
      </Link>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {NAV.map((g, gi) => (
          <Fragment key={g.id}>
            {gi > 0 && <div className="my-1.5 h-px w-6 shrink-0 bg-border" />}
            {g.items.filter(visible).map((item) => (
              <RailTooltip key={item.href} label={item.label}>
                <Link
                  href={item.href}
                  aria-label={item.label}
                  className={itemClass(isActive(pathname, item.href))}
                >
                  <Icon name={item.icon} size={19} filled={isActive(pathname, item.href)} />
                </Link>
              </RailTooltip>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="mt-2 flex shrink-0 flex-col items-center gap-1">
        <RailTooltip label={isDark ? "Light mode" : "Dark mode"}>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className={itemClass(false)}
          >
            <Icon name={isDark ? "light_mode" : "dark_mode"} size={19} />
          </button>
        </RailTooltip>
        <AccountMenu auth={auth} active={pathname.startsWith(SETTINGS_HREF)} />
      </div>
    </nav>
  );
}
