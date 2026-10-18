"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/ui";
import { cn } from "@/ui/cn";
import { About, Appearance, Backup, Network, RequestLogging, Routing } from "./General";
import { Login } from "./Login";
import { Sso } from "./Sso";
import { useSettings } from "./useSettings";

const INDEX = [
  { id: "appearance", icon: "palette", title: "Appearance" },
  { id: "login", icon: "lock", title: "Login & password" },
  { id: "sso", icon: "badge", title: "Single sign-on" },
  { id: "routing", icon: "alt_route", title: "Routing" },
  { id: "network", icon: "lan", title: "Network" },
  { id: "request-logging", icon: "receipt_long", title: "Request logging" },
  { id: "backup", icon: "save", title: "Backup" },
  { id: "about", icon: "info", title: "About" },
];

/** Highlights the section nearest the top of the scrolling <main>. */
function useCurrentSection() {
  const [at, setAt] = useState(INDEX[0].id);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = INDEX.find((s) => seen.get(s.id));
        if (first) setAt(first.id);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const s of INDEX) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return [at, setAt] as const;
}

export function SettingsPage() {
  const api = useSettings();
  const s = api.settings;
  const [at, setAt] = useCurrentSection();
  const attention: Record<string, boolean> = {
    login: !!s && (s.requireLogin === false || !s.hasPassword),
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10">
      <nav
        aria-label="Settings sections"
        className="sticky top-8 hidden h-fit w-48 shrink-0 md:block"
      >
        {INDEX.map((x) => (
          <a
            key={x.id}
            href={`#${x.id}`}
            onClick={() => setAt(x.id)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px]",
              at === x.id
                ? "bg-surface font-medium text-text shadow-sm"
                : "text-text-muted hover:text-text",
            )}
          >
            <Icon name={x.icon} size={16} className={at === x.id ? "text-accent" : undefined} />
            {x.title}
            {attention[x.id] && (
              <span
                className="ml-auto size-1.5 rounded-full bg-warning"
                aria-label="Needs attention"
              />
            )}
          </a>
        ))}
      </nav>
      <div className="min-w-0 flex-1 space-y-10">
        <Appearance />
        <Login api={api} />
        <Sso api={api} />
        <Routing api={api} />
        <Network api={api} />
        <RequestLogging api={api} />
        <Backup api={api} />
        <About />
      </div>
    </div>
  );
}
