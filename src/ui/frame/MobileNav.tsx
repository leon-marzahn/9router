"use client";

import { Logo } from "../Logo";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "@/shared/hooks/useTheme";
import { Icon } from "../Icon";
import { cn } from "../cn";
import { NAV, SETTINGS_HREF, isActive } from "./nav";
import { logout } from "./useFrameData";

/** Full-label navigation drawer for small screens (below md). */
export function MobileNav({
  open,
  onClose,
  flags,
}: {
  open: boolean;
  onClose: () => void;
  flags: { enableTranslator?: boolean };
}) {
  const pathname = usePathname() ?? "";
  const { isDark, toggleTheme } = useTheme() as { isDark: boolean; toggleTheme: () => void };
  const link = (href: string, label: string, icon: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      onClick={onClose}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px]",
        active ? "bg-bg font-medium text-text" : "text-text-muted hover:bg-bg/60 hover:text-text",
      )}
    >
      <Icon name={icon} size={20} filled={active} className={active ? "text-accent" : undefined} />
      {label}
    </Link>
  );

  return (
    <div
      className={cn("fixed inset-0 z-[70] md:hidden", !open && "pointer-events-none")}
      aria-hidden={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <nav
        aria-label="Main"
        className={cn(
          "absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface p-3 shadow-elev transition-transform duration-300",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-3 flex items-center gap-2 px-2">
          <Logo size={32} />
          <span className="font-display text-lg">Elizabeth&rsquo;s Proxy</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="ml-auto grid size-8 place-items-center rounded-lg text-text-muted hover:bg-bg/60"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {NAV.map((g) => (
          <div key={g.id} className="mb-3 space-y-0.5">
            <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-text-subtle">
              {g.label}
            </div>
            {g.items
              .filter((i) => !i.flag || flags[i.flag])
              .map((i) => link(i.href, i.label, i.icon, isActive(pathname, i.href)))}
          </div>
        ))}
        <div className="mt-auto space-y-0.5 border-t border-border pt-3">
          {link(SETTINGS_HREF, "Settings", "tune", pathname.startsWith(SETTINGS_HREF))}
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-text-muted hover:bg-bg/60"
          >
            <Icon name={isDark ? "light_mode" : "dark_mode"} size={18} />{" "}
            {isDark ? "Light mode" : "Dark mode"}
          </button>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-danger-text hover:bg-danger-soft"
          >
            <Icon name="logout" size={18} /> Log out
          </button>
        </div>
      </nav>
    </div>
  );
}
