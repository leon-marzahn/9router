export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Only shown when the matching settings flag is on. */
  flag?: "enableTranslator";
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const MEDIA_ROOT = "/dashboard/media-providers";

export const NAV: NavGroup[] = [
  {
    id: "gateway",
    label: "Gateway",
    items: [
      { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
      { href: "/dashboard/providers", label: "Providers", icon: "dns" },
      { href: MEDIA_ROOT, label: "Media Providers", icon: "perm_media" },
      { href: "/dashboard/combos", label: "Combos", icon: "layers" },
      { href: "/dashboard/request-pipelines", label: "Request Pipelines", icon: "filter_alt" },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    items: [
      { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
      { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
      { href: "/dashboard/console-log", label: "Console Log", icon: "receipt_long" },
      {
        href: "/dashboard/translator",
        label: "Translator",
        icon: "translate",
        flag: "enableTranslator",
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
      { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
      { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
      { href: "/dashboard/skills", label: "Skills", icon: "extension" },
      { href: "/dashboard/basic-chat", label: "Playground", icon: "chat" },
      { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
    ],
  },
];

export const SETTINGS_HREF = "/dashboard/profile";

/** Pages that manage their own panes/scrolling (no padding, no max-width). */
const FULL_BLEED_PREFIXES = ["/dashboard/basic-chat"];
const FULL_BLEED_EXACT = [
  "/dashboard/providers",
  "/dashboard/quota",
  "/dashboard/combos",
  "/dashboard/cli-tools",
  "/dashboard/media-providers",
  "/dashboard/request-pipelines",
  "/dashboard/proxy-pools",
];

export function isFullBleed(pathname: string): boolean {
  return (
    FULL_BLEED_EXACT.includes(pathname) || FULL_BLEED_PREFIXES.some((r) => pathname.startsWith(r))
  );
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard/endpoint") return pathname === "/dashboard" || pathname.startsWith(href);
  return pathname.startsWith(href);
}
