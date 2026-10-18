import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
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
const kinds = MEDIA_PROVIDER_KINDS as { id: string; label: string }[];
const providers = {
  ...(OAUTH_PROVIDERS as Record<string, Named>),
  ...(APIKEY_PROVIDERS as Record<string, Named>),
};

// First match wins, so more specific prefixes come first.
const TITLES: [string, string][] = [
  ["/dashboard/providers", "Providers"],
  ["/dashboard/combos", "Combos"],
  ["/dashboard/usage", "Usage & Analytics"],
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
  ["/dashboard/basic-chat", "Chat"],
  ["/dashboard/pxpipe", "PXPIPE"],
];

export function getPageMeta(pathname: string): PageMeta {
  const mediaDetail = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetail) {
    const [, kindId, id] = mediaDetail;
    const kind = kinds.find((k) => k.id === kindId);
    const name = (AI_PROVIDERS as Record<string, Named>)[id]?.name || id;
    return {
      title: name,
      crumbs: [
        { label: kind?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: name, image: getProviderIconSrc(id) ?? undefined },
      ],
    };
  }
  const mediaKind = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKind) {
    const kind = kinds.find((k) => k.id === mediaKind[1]);
    return {
      title: kind?.label || (mediaKind[1] === "web" ? "Web Fetch & Search" : mediaKind[1]),
      crumbs: [],
    };
  }
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
