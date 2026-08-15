import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  expandHomePath,
  getBrowserOpenInvocation,
  getClaudeDesktopDataHome,
  getCommandInvocation,
  getDefaultConfigDirectory,
  invalidateClaudeDesktopDataHome,
} from "../lib/platform.mjs";

test("Windows paths use the user profile and roaming application data", () => {
  const home = "C:\\Users\\Mallik";
  const appData = `${home}\\AppData\\Roaming`;

  assert.equal(
    expandHomePath("~\\.claude", { home, platform: "win32" }),
    `${home}\\.claude`,
  );
  assert.equal(
    getDefaultConfigDirectory({ env: { APPDATA: appData }, home, platform: "win32" }),
    `${appData}\\session-steward`,
  );
});

test("Windows ignores environment folders that name no drive", () => {
  const home = "C:\\Users\\Mallik";
  const appData = `${home}\\AppData\\Roaming`;

  // Git Bash and MSYS2 export POSIX paths that path.win32.isAbsolute accepts,
  // and a drive-relative folder follows whichever drive is current.
  assert.equal(
    getDefaultConfigDirectory({
      env: { APPDATA: appData, XDG_CONFIG_HOME: "/home/mallik/.config" },
      home,
      platform: "win32",
    }),
    `${appData}\\session-steward`,
  );
  assert.equal(
    getDefaultConfigDirectory({ env: { APPDATA: "\\\\server\\share" }, home, platform: "win32" }),
    "\\\\server\\share\\session-steward",
  );
  assert.equal(
    getDefaultConfigDirectory({ env: { APPDATA: "//server/share" }, home, platform: "win32" }),
    "\\\\server\\share\\session-steward",
  );
  assert.equal(
    getDefaultConfigDirectory({ env: { APPDATA: "/roaming" }, home, platform: "win32" }),
    `${home}\\AppData\\Roaming\\session-steward`,
  );
  assert.equal(
    getDefaultConfigDirectory({ env: { XDG_CONFIG_HOME: "/home/mallik/.config" }, home, platform: "linux" }),
    "/home/mallik/.config/session-steward",
  );
});

test("Claude Desktop discovery reads the file system once per home", (context) => {
  const home = "C:\\Users\\Mallik";
  const env = { APPDATA: `${home}\\AppData\\Roaming`, LOCALAPPDATA: `${home}\\AppData\\Local` };
  let reads = 0;
  const fileSystem = {
    existsSync: () => {
      reads += 1;
      return true;
    },
    readdirSync: () => [],
  };
  const options = { env, fileSystem, home, platform: "win32" };

  invalidateClaudeDesktopDataHome();
  context.after(() => invalidateClaudeDesktopDataHome());

  const resolved = getClaudeDesktopDataHome(options);
  assert.equal(reads, 1);

  // Listings resolve paths on every request, so repeats must not touch the disk.
  assert.equal(getClaudeDesktopDataHome(options), resolved);
  assert.equal(getClaudeDesktopDataHome(options), resolved);
  assert.equal(reads, 1);

  // A different profile is a different answer, not a cache hit.
  const other = getClaudeDesktopDataHome({
    ...options,
    env: { APPDATA: "D:\\Profiles\\Other\\AppData\\Roaming" },
    home: "D:\\Profiles\\Other",
  });
  assert.equal(other, "D:\\Profiles\\Other\\AppData\\Roaming\\Claude");
  assert.equal(reads, 2);

  invalidateClaudeDesktopDataHome();
  assert.equal(getClaudeDesktopDataHome(options), resolved);
  assert.equal(reads, 3);
});

test("Windows Claude Desktop discovery prefers the standalone data folder", (context) => {
  invalidateClaudeDesktopDataHome();
  context.after(() => invalidateClaudeDesktopDataHome());
  const existing = new Set([
    "C:\\Users\\Mallik\\AppData\\Roaming\\Claude\\claude-code-sessions",
  ]);
  const fileSystem = {
    existsSync: (value) => existing.has(value),
    readdirSync: () => [],
  };

  assert.equal(getClaudeDesktopDataHome({
    env: {
      APPDATA: "C:\\Users\\Mallik\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Mallik\\AppData\\Local",
    },
    fileSystem,
    home: "C:\\Users\\Mallik",
    platform: "win32",
  }), "C:\\Users\\Mallik\\AppData\\Roaming\\Claude");
});

test("Windows Claude Desktop discovery finds Microsoft Store data", (context) => {
  invalidateClaudeDesktopDataHome();
  context.after(() => invalidateClaudeDesktopDataHome());
  const sessionsPath = "C:\\Users\\Mallik\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code-sessions";
  const fileSystem = {
    existsSync: (value) => value === sessionsPath,
    readdirSync: () => [{ isDirectory: () => true, name: "Claude_pzs8sxrjxfjjc" }],
  };

  assert.equal(getClaudeDesktopDataHome({
    env: {
      APPDATA: "C:\\Users\\Mallik\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Mallik\\AppData\\Local",
    },
    fileSystem,
    home: "C:\\Users\\Mallik",
    platform: "win32",
  }), "C:\\Users\\Mallik\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude");
});

test("Windows browser and CLI commands run through cmd.exe", () => {
  const env = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  assert.deepEqual(
    getBrowserOpenInvocation("http://127.0.0.1:49152", { env, platform: "win32" }),
    {
      args: ["/d", "/s", "/c", "start", "", "http://127.0.0.1:49152"],
      command: env.ComSpec,
      windowsHide: true,
    },
  );
  assert.deepEqual(
    getCommandInvocation("codex", ["--version"], { env, platform: "win32" }),
    {
      args: ["/d", "/s", "/c", "codex", "--version"],
      command: env.ComSpec,
      windowsHide: true,
    },
  );
});

test("Windows command invocation executes command shims", {
  skip: process.platform !== "win32",
}, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-command-"));
  const commandPath = path.join(directory, "session-steward-version.cmd");
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  await fs.writeFile(commandPath, "@echo off\r\necho 1.2.3\r\n", "utf8");

  const invocation = getCommandInvocation(commandPath, ["--version"]);
  const output = execFileSync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: invocation.windowsHide,
  });
  assert.equal(output.trim(), "1.2.3");
});
