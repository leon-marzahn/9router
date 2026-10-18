// Level choices for the two answer-shortening styles on the Token Saver page.
// Ids must match open-sse/rtk/cavemanPrompts.js and ponytailPrompt.js.

export interface Level {
  id: string;
  label: string;
  desc: string;
  /** Classical-Chinese variants, offered only when the dashboard is in Chinese. */
  wenyan?: boolean;
}

export const WENYAN_LOCALES = ["zh-CN", "zh-TW"];

export const CAVEMAN_LEVELS: Level[] = [
  { id: "lite", label: "Lite", desc: "Drops filler words but keeps full sentences." },
  { id: "full", label: "Full", desc: "Drops articles too; short fragments are fine." },
  { id: "ultra", label: "Ultra", desc: "Telegraph style. Shortest answers, hardest to read." },
  {
    id: "wenyan-lite",
    label: "文 Lite",
    desc: "Classical Chinese, lightly compressed.",
    wenyan: true,
  },
  { id: "wenyan", label: "文 Full", desc: "Full 文言文, about 80–90% shorter.", wenyan: true },
  {
    id: "wenyan-ultra",
    label: "文 Ultra",
    desc: "Classical Chinese, as short as it gets.",
    wenyan: true,
  },
];

export const PONYTAIL_LEVELS: Level[] = [
  { id: "lite", label: "Lite", desc: "Builds what you asked, and mentions a simpler option." },
  { id: "full", label: "Full", desc: "Reaches for the standard library and built-ins first." },
  {
    id: "ultra",
    label: "Ultra",
    desc: "Pushes back on anything not needed yet; prefers deleting code.",
  },
];
