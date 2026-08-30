import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getDefaultConfigDirectory } from "./platform.mjs";

const execFile = promisify(execFileCallback);
const LABEL = "com.mallikcheripally.session-steward.cleanup";
const WINDOWS_TASK_NAME = "Session Steward Cleanup";
const RUNNER_PATH = fileURLToPath(new URL("../bin/session-steward-scheduler.mjs", import.meta.url));

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdArgument(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

function windowsArgument(value) {
  return `"${String(value).replaceAll(/(\\*)"/gu, "$1$1\\\"").replaceAll(/(\\+)$/gu, "$1$1")}"`;
}

async function writePrivateFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createCleanupSchedulerService({
  configDirectory = getDefaultConfigDirectory(),
  environment = process.env,
  execute = execFile,
  home = os.homedir(),
  nodePath = process.execPath,
  platform = process.platform,
  runnerPath = RUNNER_PATH,
  userId = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  const launchAgentPath = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const xdgConfigHome = path.isAbsolute(environment.XDG_CONFIG_HOME || "")
    ? environment.XDG_CONFIG_HOME
    : path.join(home, ".config");
  const systemdDirectory = path.join(xdgConfigHome, "systemd", "user");
  const systemdServicePath = path.join(systemdDirectory, "session-steward-cleanup.service");
  const systemdTimerPath = path.join(systemdDirectory, "session-steward-cleanup.timer");

  async function command(commandName, args, { allowFailure = false } = {}) {
    try {
      await execute(commandName, args, { windowsHide: true });
      return true;
    } catch (error) {
      if (allowFailure) return false;
      throw new Error("Session Steward could not update the automatic cleanup scheduler.", {
        cause: error,
      });
    }
  }

  async function start() {
    if (platform === "darwin") {
      if (!Number.isSafeInteger(userId)) throw new Error("Session Steward could not identify this user.");
      const target = `gui/${userId}`;
      await writePrivateFile(launchAgentPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string>
    <string>${xml(runnerPath)}</string>
    <string>--run-due</string>
    <string>--config-directory</string>
    <string>${xml(configDirectory)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>900</integer>
</dict></plist>
`);
      await command("launchctl", ["bootout", `${target}/${LABEL}`], { allowFailure: true });
      await command("launchctl", ["bootstrap", target, launchAgentPath]);
      await command("launchctl", ["enable", `${target}/${LABEL}`]);
      return status();
    }

    if (platform === "linux") {
      await writePrivateFile(systemdServicePath, `[Unit]
Description=Session Steward automatic cleanup

[Service]
Type=oneshot
ExecStart=${systemdArgument(nodePath)} ${systemdArgument(runnerPath)} --run-due --config-directory ${systemdArgument(configDirectory)}
`);
      await writePrivateFile(systemdTimerPath, `[Unit]
Description=Run Session Steward automatic cleanup

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
`);
      await command("systemctl", ["--user", "daemon-reload"]);
      await command("systemctl", ["--user", "enable", "--now", "session-steward-cleanup.timer"]);
      return status();
    }

    if (platform === "win32") {
      const taskCommand = [
        nodePath,
        runnerPath,
        "--run-due",
        "--config-directory",
        configDirectory,
      ].map(windowsArgument).join(" ");
      await command("schtasks", [
        "/Create", "/F", "/SC", "MINUTE", "/MO", "15",
        "/TN", WINDOWS_TASK_NAME,
        "/TR", taskCommand,
      ]);
      return status();
    }

    throw new Error(`Automatic cleanup is not supported on ${platform}.`);
  }

  async function stop() {
    if (platform === "darwin") {
      if (Number.isSafeInteger(userId)) {
        await command("launchctl", ["bootout", `gui/${userId}/${LABEL}`], {
          allowFailure: true,
        });
      }
      await fs.rm(launchAgentPath, { force: true });
      return status();
    }
    if (platform === "linux") {
      await command("systemctl", ["--user", "disable", "--now", "session-steward-cleanup.timer"], {
        allowFailure: true,
      });
      await Promise.all([
        fs.rm(systemdServicePath, { force: true }),
        fs.rm(systemdTimerPath, { force: true }),
      ]);
      await command("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
      return status();
    }
    if (platform === "win32") {
      await command("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME], {
        allowFailure: true,
      });
      return status();
    }
    return { platform, running: false, supported: false };
  }

  async function status() {
    if (platform === "darwin") {
      const running = Number.isSafeInteger(userId)
        ? await command("launchctl", ["print", `gui/${userId}/${LABEL}`], { allowFailure: true })
        : false;
      return { platform, running, supported: true };
    }
    if (platform === "linux") {
      const configured = await exists(systemdTimerPath);
      const running = configured
        ? await command("systemctl", ["--user", "is-active", "--quiet", "session-steward-cleanup.timer"], {
          allowFailure: true,
        })
        : false;
      return { platform, running, supported: true };
    }
    if (platform === "win32") {
      const running = await command("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], {
        allowFailure: true,
      });
      return { platform, running, supported: true };
    }
    return { platform, running: false, supported: false };
  }

  return { start, status, stop };
}
