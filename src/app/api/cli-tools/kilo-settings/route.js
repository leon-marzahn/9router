"use server";

import { NextResponse } from "next/server";
import { configWriter } from "../configFile.js";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { DISPLAY_NAME, pickProvider, deleteProviderKeys, mentionsBrand } from "@/shared/constants/brand.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { parseJSONC } from "confbox";
import { vscodeUserDir } from "./vscodePaths.js";
import os from "os";

const { writeConfigFile } = configWriter("kilo");

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".local", "share", "kilo");
const getAuthPath = () => path.join(getDataDir(), "auth.json");
const getVscodeSettingsPath = () => path.join(vscodeUserDir(), "settings.json");

// settings.json is JSONC. Missing → {}; present but unreadable → null, so we never
// replace a file we could not parse with just our two keys.
const readVscodeSettings = async () => {
  let content;
  try {
    content = await fs.readFile(getVscodeSettingsPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return null;
  }
  try {
    const parsed = parseJSONC(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where kilo" : "which kilo";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getAuthPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const hasRegentConfig = (auth) => {
  if (!auth) return false;
  const entry = auth["openai-compatible"] || pickProvider(auth);
  if (!entry) return false;
  const baseUrl = entry.baseUrl || entry.baseURL || "";
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || mentionsBrand(baseUrl);
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Kilo Code CLI is not installed" });
    }
    const auth = await readJson(getAuthPath());
    return NextResponse.json({
      installed: true,
      settings: { auth: auth ? Object.keys(auth) : [] },
      hasRegent: hasRegentConfig(auth),
      authPath: getAuthPath(),
    });
  } catch (error) {
    console.log("Error checking kilo settings:", error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey: callerKey, model } = await request.json();
    const apiKey = await resolveCliApiKey(callerKey);
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    const auth = (await readJson(getAuthPath())) || {};
    auth["openai-compatible"] = {
      type: "api-key",
      apiKey,
      baseUrl: normalizedBaseUrl,
      model,
    };
    await writeConfigFile(getAuthPath(), JSON.stringify(auth, null, 2));

    // Best-effort: update VS Code extension settings
    try {
      const vscode = await readVscodeSettings();
      if (vscode) {
        vscode["kilocode.customProvider"] = { name: DISPLAY_NAME, baseURL: normalizedBaseUrl, apiKey };
        vscode["kilocode.defaultModel"] = model;
        await fs.mkdir(vscodeUserDir(), { recursive: true });
        await writeConfigFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
      }
    } catch { /* VS Code settings not writable */ }

    return NextResponse.json({ success: true, message: "Kilo Code settings applied successfully!", authPath: getAuthPath() });
  } catch (error) {
    console.log("Error updating kilo settings:", error);
    return NextResponse.json({ error: "Failed to update kilo settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const auth = await readJson(getAuthPath());
    if (!auth) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    delete auth["openai-compatible"];
    deleteProviderKeys(auth);
    await writeConfigFile(getAuthPath(), JSON.stringify(auth, null, 2));

    try {
      const vscode = await readVscodeSettings();
      if (vscode && ("kilocode.customProvider" in vscode || "kilocode.defaultModel" in vscode)) {
        delete vscode["kilocode.customProvider"];
        delete vscode["kilocode.defaultModel"];
        await writeConfigFile(getVscodeSettingsPath(), JSON.stringify(vscode, null, 2));
      }
    } catch { /* ignore */ }

    return NextResponse.json({ success: true, message: `${DISPLAY_NAME} settings removed from Kilo Code` });
  } catch (error) {
    console.log("Error resetting kilo settings:", error);
    return NextResponse.json({ error: "Failed to reset kilo settings" }, { status: 500 });
  }
}
