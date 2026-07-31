import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProviderSettings } from "../lib/settings.mjs";
import {
  createCodexHomeFixture,
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "bin", "session-steward-cli.mjs");

async function runCli(args, xdgConfigHome) {
  const { stdout } = await executeFile(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome },
  });
  return stdout;
}

test("the terminal CLI uses saved settings while command-line overrides remain temporary", async (context) => {
  const savedFixture = await createLargeCodexHomeFixture({ sessionCount: 4 });
  const overrideFixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-config-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(savedFixture.codexHome),
      removeCodexHomeFixture(overrideFixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  const settings = await createProviderSettings({
    configDirectory: path.join(xdgConfigHome, "session-steward"),
  });
  await settings.setProviderHome("codex", savedFixture.codexHome);

  const savedSessions = JSON.parse(await runCli(["--json", "--include-internals"], xdgConfigHome));
  assert.equal(savedSessions.length, 7);

  const overriddenSessions = JSON.parse(await runCli([
    "--codex-home",
    overrideFixture.codexHome,
    "--json",
    "--include-internals",
  ], xdgConfigHome));
  assert.equal(overriddenSessions.length, 3);

  const config = JSON.parse(await fs.readFile(
    path.join(xdgConfigHome, "session-steward", "config.json"),
    "utf8",
  ));
  assert.equal(config.providers.codex.home, savedFixture.codexHome);
});

test("help does not read provider settings", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-help-"));
  const unusableConfigHome = path.join(directory, "not-a-directory");
  await fs.writeFile(unusableConfigHome, "This is a file.", "utf8");
  context.after(() => fs.rm(directory, { force: true, recursive: true }));

  const output = await runCli(["--help"], unusableConfigHome);
  assert.match(output, /^Usage: session-steward-cli/u);
});
