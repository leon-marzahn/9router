"use server";

import { NextResponse } from "next/server";
import { configWriter } from "../configFile.js";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { dotenvString, configErrorStatus } from "../configText.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { DISPLAY_NAME, PROVIDER_KEY, LEGACY_PROVIDER_KEY, PROVIDER_KEYS, pickProvider, deleteProviderKeys } from "@/shared/constants/brand.js";

const { writeConfigFile, removeConfigFile } = configWriter("jcode");

const execAsync = promisify(exec);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

// jcode reads the key from ~/.config/jcode/provider-<key>.env as JCODE_<KEY>_API_KEY.
// Current key: provider-regent.env / JCODE_REGENT_API_KEY; legacy: provider-9router.env.
const envFileName = (key = PROVIDER_KEY) => `provider-${key}.env`;
const envVarName = (key = PROVIDER_KEY) => `JCODE_${key.toUpperCase()}_API_KEY`;

const getProviderEnvPath = (key = PROVIDER_KEY) => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", envFileName(key));
};

// Remove the legacy env file (only our own key lived there); ignore if absent.
const removeLegacyProviderEnv = async () => {
  try {
    await removeConfigFile(getProviderEnvPath(LEGACY_PROVIDER_KEY));
  } catch { /* not present */ }
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    return { providers: {} };
  }
};

const hasRegentConfig = (config) => {
  if (!config || !config.providers) return false;

  const providers = config.providers;

  if (pickProvider(providers)) return true;

  for (const [name, provider] of Object.entries(providers)) {
    if (provider.base_url && provider.base_url.includes("localhost:20128")) {
      return true;
    }
  }

  return false;
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await writeConfigFile(configPath, content, "utf-8");
};

const readProviderEnv = async () => {
  try {
    const envPath = getProviderEnvPath();
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env) => {
  const envPath = getProviderEnvPath();
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}=${dotenvString(value, key)}\n`;
  }

  await writeConfigFile(envPath, content, "utf-8");
};

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();
  const hasRegent = hasRegentConfig(config);

  return NextResponse.json({
    installed: true,
    config,
    hasRegent,
    configPath: getConfigPath(),
  });
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey: callerKey, models } = await request.json();
    const apiKey = await resolveCliApiKey(callerKey);

    if (!baseUrl) {
      return NextResponse.json(
        { error: "baseUrl is required" },
        { status: 400 }
      );
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

    let config = await readConfig();

    if (!config.providers) {
      config.providers = {};
    }

    delete config.providers[LEGACY_PROVIDER_KEY];
    config.providers[PROVIDER_KEY] = {
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: envVarName(),
      env_file: envFileName(),
      default_model: models && models.length > 0 ? models[0] : "cc/claude-opus-4-7",
      requires_api_key: true,
    };

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    await writeConfig(config);

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const jcodeConfigDir = path.join(xdgConfigDir, "jcode");
    await fs.mkdir(jcodeConfigDir, { recursive: true });

    const env = await readProviderEnv();
    delete env[envVarName(LEGACY_PROVIDER_KEY)];
    env[envVarName()] = apiKey;
    await writeProviderEnv(env);
    await removeLegacyProviderEnv();

    return NextResponse.json({
      success: true,
      message: `jcode configured successfully. Use: jcode --provider-profile ${PROVIDER_KEY}`,
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.error("Error configuring jcode:", error);
    return NextResponse.json(
      { error: error.message },
      { status: configErrorStatus(error) }
    );
  }
}

export async function DELETE() {
  try {
    const config = await readConfig();

    if (!config.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    deleteProviderKeys(config.providers);

    await writeConfig(config);

    const env = await readProviderEnv();
    for (const key of PROVIDER_KEYS) delete env[envVarName(key)];
    await writeProviderEnv(env);
    await removeLegacyProviderEnv();

    return NextResponse.json({
      success: true,
      message: `${DISPLAY_NAME} configuration removed from jcode`,
    });
  } catch (error) {
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json(
      { error: error.message },
      { status: configErrorStatus(error) }
    );
  }
}
