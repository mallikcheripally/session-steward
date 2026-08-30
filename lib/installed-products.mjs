import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";

import { getCommandInvocation } from "./platform.mjs";

function readCommandVersion(command, args) {
  try {
    const invocation = getCommandInvocation(command, args);
    return execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: invocation.windowsHide,
    }).trim() || null;
  } catch {
    return null;
  }
}

export async function getInstalledProductVersions() {
  const versions = {
    chatgptDesktop: null,
    claudeCli: readCommandVersion("claude", ["--version"]),
    claudeDesktop: null,
    codexCli: readCommandVersion("codex", ["--version"]),
  };

  if (process.platform !== "darwin") return versions;

  const applications = [
    ["chatgptDesktop", "/Applications/ChatGPT.app/Contents/Info.plist"],
    ["claudeDesktop", "/Applications/Claude.app/Contents/Info.plist"],
  ];
  for (const [key, infoPath] of applications) {
    try {
      await fs.access(infoPath);
      versions[key] = readCommandVersion(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :CFBundleShortVersionString", infoPath],
      );
    } catch {
    }
  }
  return versions;
}
