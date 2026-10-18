import { redirect } from "next/navigation";
import { mediaHref } from "../workbench/href";

// Web search + fetch shared one page; they are two kinds in the workbench.
export default function MediaWebRedirect() {
  redirect(mediaHref({ kind: "webSearch" }));
}
