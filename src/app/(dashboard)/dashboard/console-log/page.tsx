import { ConsoleLog } from "./ConsoleLog";

// Force dynamic so the standalone build includes the server-side log capture.
export const dynamic = "force-dynamic";

export default function ConsoleLogPage() {
  return <ConsoleLog />;
}
