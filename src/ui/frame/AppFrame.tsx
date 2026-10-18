"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "../cn";
import { Rail } from "./Rail";
import { MobileNav } from "./MobileNav";
import { TopBar } from "./TopBar";
import { Toasts } from "./Toasts";
import { FrameSlotsProvider } from "./slots";
import { isFullBleed } from "./nav";
import { useFrameData } from "./useFrameData";

/**
 * Dashboard shell: icon rail | (top bar / page). Pages render into the
 * scrolling content area; full-bleed routes (see isFullBleed) get the raw
 * area and manage their own panes.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const { flags, auth } = useFrameData();
  const fullBleed = isFullBleed(pathname);

  return (
    <FrameSlotsProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-bg text-[13px] text-text">
        <Rail flags={flags} auth={auth} />
        <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} flags={flags} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onMenu={() => setMenuOpen(true)} />
          <main
            className={cn(
              "min-h-0 flex-1",
              fullBleed ? "flex flex-col overflow-hidden" : "overflow-y-auto",
            )}
          >
            {fullBleed ? (
              children
            ) : (
              <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
                {children}
              </div>
            )}
          </main>
        </div>
        <Toasts />
      </div>
    </FrameSlotsProvider>
  );
}
