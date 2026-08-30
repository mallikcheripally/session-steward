import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expandHomePath,
  getDefaultConfigDirectory as resolveDefaultConfigDirectory,
} from "./platform.mjs";

const CONFIG_VERSION = 1;
const PROVIDERS = {
  codex: {
    defaultHome: () => path.join(os.homedir(), ".codex"),
    displayName: "Codex",
    homeLabel: "Codex home folder",
    homePlaceholder: "~/.codex",
  },
  "claude-code": {
    defaultHome: () => process.env.CLAUDE_CONFIG_DIR && path.isAbsolute(process.env.CLAUDE_CONFIG_DIR)
      ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
      : path.join(os.homedir(), ".claude"),
    displayName: "Claude Code",
    homeLabel: "Claude home folder",
    homePlaceholder: "~/.claude",
  },
};

function normalizeHome(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Enter a valid folder path.");
  }

  const expanded = expandHomePath(value.trim());

  if (!expanded || !path.isAbsolute(expanded)) {
    throw new Error("Enter a full folder path, such as ~/.codex.");
  }

  return path.resolve(expanded);
}

function getProviderDefinition(providerId) {
  const definition = PROVIDERS[providerId];

  if (!definition) {
    throw new Error("That session provider is not available.");
  }

  return definition;
}

export function getDefaultConfigDirectory() {
  return resolveDefaultConfigDirectory();
}

async function readConfig(configPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));

    if (parsed?.version !== CONFIG_VERSION || typeof parsed.providers !== "object" || !parsed.providers) {
      return { providers: {}, version: CONFIG_VERSION };
    }

    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { providers: {}, version: CONFIG_VERSION };
    }

    throw new Error("Session Steward could not read its saved settings.", { cause: error });
  }
}

async function writeConfig(configPath, config) {
  const configDirectory = path.dirname(configPath);
  const temporaryPath = path.join(
    configDirectory,
    `.config-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  await fs.mkdir(configDirectory, { mode: 0o700, recursive: true });

  let handle;

  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function requireExistingDirectory(value) {
  const home = normalizeHome(value);
  let stats;

  try {
    stats = await fs.stat(home);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Choose an existing folder.");
    }

    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new Error("Session Steward cannot open this folder.");
    }

    throw new Error("Session Steward could not check this folder.", { cause: error });
  }

  if (!stats.isDirectory()) {
    throw new Error("Choose a folder, not a file.");
  }

  return home;
}

export async function createProviderSettings({ configDirectory, providerHomeOverrides = {} } = {}) {
  const resolvedConfigDirectory = configDirectory === undefined
    ? getDefaultConfigDirectory()
    : normalizeHome(configDirectory);
  const configPath = path.join(resolvedConfigDirectory, "config.json");
  let config = await readConfig(configPath);
  const startupHomes = {};
  const savedHomes = {};
  const activeHomes = {};

  for (const [providerId, definition] of Object.entries(PROVIDERS)) {
    const override = providerHomeOverrides[providerId];
    const savedValue = config.providers?.[providerId]?.home;
    let savedHome = null;

    try {
      savedHome = savedValue === undefined ? null : normalizeHome(savedValue);
    } catch {
      savedHome = null;
    }
    savedHomes[providerId] = savedHome;

    if (override !== undefined) {
      startupHomes[providerId] = await requireExistingDirectory(override);
    }

    activeHomes[providerId] = startupHomes[providerId]
      || savedHome
      || definition.defaultHome();
  }

  function getProvider(providerId) {
    const definition = getProviderDefinition(providerId);
    const defaultHome = definition.defaultHome();
    const home = activeHomes[providerId];

    return {
      defaultHome,
      displayName: definition.displayName,
      home,
      homeLabel: definition.homeLabel,
      homePlaceholder: definition.homePlaceholder,
      isDefault: home === defaultHome,
      source: startupHomes[providerId] && home === startupHomes[providerId]
        ? "startup"
        : savedHomes[providerId] && home === savedHomes[providerId]
          ? "saved"
          : "default",
    };
  }

  function getActiveProviderId() {
    return typeof config.activeProviderId === "string" && PROVIDERS[config.activeProviderId]
      ? config.activeProviderId
      : "codex";
  }

  async function setActiveProviderId(providerId) {
    getProviderDefinition(providerId);
    const nextConfig = {
      ...config,
      activeProviderId: providerId,
      providers: config.providers,
      version: CONFIG_VERSION,
    };
    try {
      await writeConfig(configPath, nextConfig);
    } catch (error) {
      throw new Error("Session Steward could not remember this provider.", { cause: error });
    }
    config = nextConfig;
    return providerId;
  }

  async function setProviderHome(providerId, value) {
    const definition = getProviderDefinition(providerId);
    const home = await requireExistingDirectory(value);

    if (home === definition.defaultHome()) {
      return resetProviderHome(providerId);
    }

    const nextConfig = {
      ...config,
      providers: {
        ...config.providers,
        [providerId]: { home },
      },
      version: CONFIG_VERSION,
    };
    try {
      await writeConfig(configPath, nextConfig);
    } catch (error) {
      throw new Error("Session Steward could not save this folder.", { cause: error });
    }
    config = nextConfig;
    activeHomes[providerId] = home;
    savedHomes[providerId] = home;
    delete startupHomes[providerId];
    return getProvider(providerId);
  }

  async function resetProviderHome(providerId) {
    const definition = getProviderDefinition(providerId);
    const providers = { ...config.providers };
    delete providers[providerId];
    const nextConfig = { ...config, providers, version: CONFIG_VERSION };
    try {
      await writeConfig(configPath, nextConfig);
    } catch (error) {
      throw new Error("Session Steward could not restore the default folder.", { cause: error });
    }
    config = nextConfig;
    activeHomes[providerId] = definition.defaultHome();
    savedHomes[providerId] = null;
    delete startupHomes[providerId];
    return getProvider(providerId);
  }

  return {
    getActiveProviderId,
    getAll: () => Object.fromEntries(Object.keys(PROVIDERS).map((providerId) => [providerId, getProvider(providerId)])),
    getConfigDirectory: () => resolvedConfigDirectory,
    getHome: (providerId) => getProvider(providerId).home,
    resetProviderHome,
    setActiveProviderId,
    setProviderHome,
  };
}
