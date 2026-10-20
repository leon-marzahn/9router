import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";

export interface Crumb {
  label: string;
  href?: string;
  image?: string;
}
export interface PageMeta {
  title: string;
  crumbs: Crumb[];
}

type Named = { name?: string; id?: string };
const providers = {
  ...(OAUTH_PROVIDERS as Record<string, Named>),
  ...(APIKEY_PROVIDERS as Record<string, Named>),
};

// First match wins, so more specific prefixes come first.
const TITLES: [string, string][] = [
  ["/dashboard/providers", "Providers"],
  ["/dashboard/media-providers", "Media Providers"],
  ["/dashboard/combos", "Combos"],
  ["/dashboard/usage", "Usage"],
  ["/dashboard/quota", "Quota Tracker"],
  ["/dashboard/mitm", "MITM Proxy"],
  ["/dashboard/token-saver", "Token Saver"],
  ["/dashboard/cli-tools", "CLI Tools"],
  ["/dashboard/proxy-pools", "Proxy Pools"],
  ["/dashboard/skills", "Agent Skills"],
  ["/dashboard/endpoint", "Endpoint"],
  ["/dashboard/profile", "Settings"],
  ["/dashboard/translator", "Translator"],
  ["/dashboard/console-log", "Console Log"],
  ["/dashboard/request-pipelines", "Request Pipelines"],
  ["/dashboard/basic-chat", "Playground"],
  ["/dashboard/pxpipe", "PXPIPE"],
];

export function getPageMeta(pathname: string): PageMeta {
  const provider = pathname.match(/\/dashboard\/providers\/([^/]+)$/);
  if (provider && provider[1] !== "new") {
    const info = providers[provider[1]];
    if (info?.name) {
      return {
        title: info.name,
        crumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          { label: info.name, image: getProviderIconSrc(info.id || provider[1]) ?? undefined },
        ],
      };
    }
  }
  const toolMatch = pathname.match(/\/cli-tools\/([^/]+)$/);
  if (toolMatch)
    return {
      title: toolMatch[1],
      crumbs: [{ label: "CLI Tools", href: "/dashboard/cli-tools" }, { label: toolMatch[1] }],
    };

  if (pathname === "/dashboard") return { title: "Endpoint", crumbs: [] };
  const hit = TITLES.find(([prefix]) => pathname.startsWith(prefix));
  return { title: hit?.[1] ?? "", crumbs: [] };
}
