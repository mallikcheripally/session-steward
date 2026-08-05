import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executeFile = promisify(execFile);
const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(repositoryRoot, "bin", "session-steward.mjs");

async function runLauncher(args) {
  const { stdout } = await executeFile(process.execPath, [launcherPath, ...args], {
    cwd: repositoryRoot,
  });
  return stdout;
}

test("the browser launcher shows help without starting the server", async () => {
  const output = await runLauncher(["--help"]);

  assert.match(output, /^Usage: session-steward/u);
  assert.match(output, /--codex-home/u);
});

test("the browser launcher reports the installed version", async () => {
  const output = await runLauncher(["--version"]);

  assert.equal(output.trim(), "0.4.0");
});
