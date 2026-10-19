import { CodeBlock } from "@/ui";
import { splitFences } from "./chat";

/** Message text with fenced code rendered as CodeBlocks (no HTML is interpreted). */
export function MessageBody({ text }: { text: string }) {
  return (
    <div className="space-y-3">
      {splitFences(text).map((seg, i) =>
        seg.kind === "code" ? (
          <CodeBlock
            key={i}
            title={seg.lang || "code"}
            copy={seg.code}
            copyLabel="Copy code"
            text={seg.code}
          />
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
            {seg.text.replace(/^\n+|\n+$/g, "")}
          </p>
        ),
      )}
    </div>
  );
}
