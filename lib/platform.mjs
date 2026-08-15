import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path;
}

export function expandHomePath(value, {
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  if (value === "~") {
    return home;
  }

  if (typeof value === "string" && /^~[\\/]/u.test(value)) {
    return pathApi(platform).join(home, value.slice(2));
  }

  return value;
}

export function getDefaultConfigDirectory({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const paths = pathApi(platform);
  const xdgConfigHome = env.XDG_CONFIG_HOME;

  if (xdgConfigHome && paths.isAbsolute(xdgConfigHome)) {
    return paths.join(xdgConfigHome, "session-steward");
  }

  if (platform === "darwin") {
    return paths.join(home, "Library", "Application Support", "session-steward");
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData && paths.isAbsolute(appData)
      ? paths.join(appData, "session-steward")
      : paths.join(home, "AppData", "Roaming", "session-steward");
  }

  return paths.join(home, ".config", "session-steward");
}

export function getClaudeDesktopDataHome({
  env = process.env,
  fileSystem = { existsSync, readdirSync },
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const paths = pathApi(platform);

  if (platform === "darwin") {
    return paths.join(home, "Library", "Application Support", "Claude");
  }

  if (platform === "win32") {
    const appData = env.APPDATA;
    const standardHome = appData && paths.isAbsolute(appData)
      ? paths.join(appData, "Claude")
      : paths.join(home, "AppData", "Roaming", "Claude");
    const sessionsName = "claude-code-sessions";

    if (fileSystem.existsSync(paths.join(standardHome, sessionsName))) {
      return standardHome;
    }

    const localAppData = env.LOCALAPPDATA;
    if (localAppData && paths.isAbsolute(localAppData)) {
      const packagesDirectory = paths.join(localAppData, "Packages");
      try {
        const packageEntries = fileSystem.readdirSync(packagesDirectory, { withFileTypes: true });
        for (const entry of packageEntries) {
          if (!entry.isDirectory() || !/^Claude_/iu.test(entry.name)) {
            continue;
          }

          const packageHome = paths.join(
            packagesDirectory,
            entry.name,
            "LocalCache",
            "Roaming",
            "Claude",
          );
          if (fileSystem.existsSync(paths.join(packageHome, sessionsName))) {
            return packageHome;
          }
        }
      } catch {
      }
    }

    return standardHome;
  }

  return null;
}

export function getBrowserOpenInvocation(url, {
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform === "darwin") {
    return { args: [url], command: "open" };
  }

  if (platform === "linux") {
    return { args: [url], command: "xdg-open" };
  }

  if (platform === "win32") {
    return {
      args: ["/d", "/s", "/c", "start", "", url],
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      windowsHide: true,
    };
  }

  return null;
}

export function getCommandInvocation(command, args, {
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    return { args, command };
  }

  return {
    args: ["/d", "/s", "/c", command, ...args],
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    windowsHide: true,
  };
}
