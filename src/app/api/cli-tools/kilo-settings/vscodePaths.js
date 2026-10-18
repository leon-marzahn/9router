import os from "os";
import path from "path";

// VS Code's user settings live in a different place per platform.
export const vscodeUserDir = (platform = os.platform(), home = os.homedir(), env = process.env) => {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "Code", "User");
  if (platform === "win32")
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User");
};
