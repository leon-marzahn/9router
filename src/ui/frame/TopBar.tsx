"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { translate } from "@/i18n/runtime";
import { Icon } from "../Icon";
import { SearchInput } from "../Field";
import { ProviderLogo } from "../ProviderLogo";
import { getPageMeta } from "./pageMeta";
import { useFrameSlots } from "./slots";

/**
 * Top bar: page title (or breadcrumbs), a center slot pages fill with
 * <TopBarContent> (e.g. a KPI strip), page actions via <TopBarActions>,
 * and the header search pages register through useHeaderSearchStore.
 */
export function TopBar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname() ?? "";
  const meta = useMemo(() => getPageMeta(pathname), [pathname]);
  const { setCenter, setActions } = useFrameSlots();

  return (
    <header className="box-content flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-[env(safe-area-inset-top)] sm:gap-4 md:px-4">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open menu"
        className="-ml-1 grid size-10 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-surface-2 md:hidden"
      >
        <Icon name="menu" size={20} />
      </button>

      {meta.crumbs.length ? (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          {meta.crumbs.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              {i > 0 && <Icon name="chevron_right" size={16} className="text-text-subtle" />}
              {c.href ? (
                <Link
                  href={c.href}
                  className="hidden truncate text-[13px] text-text-muted hover:text-text sm:inline"
                >
                  {translate(c.label)}
                </Link>
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  {c.image && <ProviderLogo src={c.image} name={c.label} size={20} />}
                  <h1 className="truncate font-display text-lg tracking-tight">
                    {translate(c.label)}
                  </h1>
                </span>
              )}
            </Fragment>
          ))}
        </nav>
      ) : (
        // Title links back to the page root (e.g. clears a workbench selection)
        <h1 className="min-w-0 truncate font-display text-lg tracking-tight">
          <Link
            href={pathname}
            className="rounded hover:text-accent-text focus-visible:outline-none focus-visible:shadow-focus"
          >
            {translate(meta.title)}
          </Link>
        </h1>
      )}

      <div
        ref={setCenter}
        className="hidden min-w-0 flex-1 items-center gap-4 overflow-hidden md:flex"
      />
      <div className="flex-1 md:hidden" />

      <div className="flex shrink-0 items-center gap-2">
        <HeaderSearch />
        <div ref={setActions} className="flex items-center gap-2" />
      </div>
    </header>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);
  if (!visible) return null;
  return (
    <SearchInput
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      placeholder={placeholder}
      className="h-8 w-40 sm:w-56"
    />
  );
}
