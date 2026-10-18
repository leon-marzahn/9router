"use server";

import { NextResponse } from "next/server";
import { configWriter } from "../configFile.js";
import { DISPLAY_NAME, PROVIDER_KEY, PROVIDER_KEYS } from "@/shared/constants/brand.js";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { yamlString, configErrorStatus } from "../configText.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const { writeConfigFile, removeConfigFile } = configWriter("omp");

const execAsync = promisify(exec);

const PROVIDER_ID = PROVIDER_KEY;
// Matches our provider block under either the current or the legacy key
const providerBlockRegex = () =>
  new RegExp(`\\s*(?:${PROVIDER_KEYS.join("|")}):[\\s\\S]*?(?=\\n\\s*\\w+:|$)`, "g");
const getOmpDir = () => path.join(os.homedir(), ".omp", "agent");
const getOmpDbPath = () => path.join(getOmpDir(), "agent.db");
const getOmpModelsYmlPath = () => path.join(getOmpDir(), "models.yml");

const checkOmpInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where omp" : "which omp";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getOmpDbPath());
      return true;
    } catch {
      try {
        await fs.access(getOmpModelsYmlPath());
        return true;
      } catch {
        return false;
      }
    }
  }
};

const readModelsYml = async () => {
  try {
    return await fs.readFile(getOmpModelsYmlPath(), "utf-8");
  } catch {
    return "";
  }
};

const hasRegentInYml = (content) => {
  if (!content) return false;
  return PROVIDER_KEYS.some((k) => content.includes(`${k}:`)) || content.includes("localhost:20128");
};

// Build our standard provider block for models.yml
const buildOmpProviderYaml = (baseUrl, apiKey) => {
  const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const key = apiKey || "";
  return `  ${PROVIDER_ID}:
    baseUrl: ${yamlString(normalizedBaseUrl, "Base URL")}
    apiKey: ${yamlString(key, "API key")}
    api: openai-completions
    authHeader: true
    disableStrictTools: true
    discovery:
      type: proxy`;
};

export async function GET() {
  try {
    const installed = await checkOmpInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Oh My Pi is not installed",
      });
    }

    const ymlContent = await readModelsYml();
    const hasRegent = hasRegentInYml(ymlContent);

    return NextResponse.json({
      installed: true,
      hasRegent,
      configPath: getOmpModelsYmlPath(),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const resolvedKey = await resolveCliApiKey(apiKey);

    await fs.mkdir(getOmpDir(), { recursive: true });

    let ymlContent = await readModelsYml();
    const providerBlock = buildOmpProviderYaml(baseUrl, resolvedKey);

    // Remove an existing provider block (current or legacy key) if present
    ymlContent = ymlContent.replace(providerBlockRegex(), "");

    if (!ymlContent.trim()) {
      ymlContent = `providers:\n${providerBlock}\n`;
    } else if (ymlContent.includes("providers:")) {
      ymlContent = ymlContent.replace(/^providers:/m, () => `providers:\n${providerBlock}`);
    } else {
      ymlContent = `${ymlContent.trim()}\n\nproviders:\n${providerBlock}\n`;
    }

    await writeConfigFile(getOmpModelsYmlPath(), ymlContent, "utf-8");

    // Best-effort update to agent.db if better-sqlite3 or node:sqlite is present
    try {
      let Database;
      try {
        const mod = await import("better-sqlite3");
        Database = mod.default || mod;
      } catch {
        // fallback ignored
      }
      if (Database) {
        const dbPath = getOmpDbPath();
        const db = new Database(dbPath);
        for (const key of PROVIDER_KEYS) db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(key);
        db.prepare(
          "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
        ).run(
          PROVIDER_ID,
          "api_key",
          JSON.stringify({ apiKey: resolvedKey, baseUrl }),
          Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000)
        );
        db.close();
      }
    } catch {
      // Non-critical: models.yml is primary
    }

    return NextResponse.json({
      success: true,
      message: `Oh My Pi settings applied! Run 'omp' and all ${DISPLAY_NAME} models appear under ${PROVIDER_ID} in /model.`,
      configPath: getOmpModelsYmlPath(),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}

export async function DELETE() {
  try {
    let ymlContent = await readModelsYml();
    ymlContent = ymlContent.replace(providerBlockRegex(), "");

    if (ymlContent.trim() === "providers:") {
      await removeConfigFile(getOmpModelsYmlPath());
    } else {
      await writeConfigFile(getOmpModelsYmlPath(), ymlContent, "utf-8");
    }

    return NextResponse.json({
      success: true,
      message: `${DISPLAY_NAME} removed from Oh My Pi`,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: configErrorStatus(err) });
  }
}
