/** Wording + call for stopping the gateway, shared by the account menu and Settings. */
export const STOP_APP = {
  title: "Stop Elizabeth's Proxy?",
  message:
    "Nothing can reach regent until you start it again: apps and tools pointed at it (Claude Code, Cursor, your scripts) get connection errors straight away, and this dashboard goes offline too. Start it again the way you launched it, from the terminal, the tray or your container.",
  confirm: "Stop regent",
};

export async function stopApp() {
  // The request usually fails because the server exits while answering.
  await fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
}
