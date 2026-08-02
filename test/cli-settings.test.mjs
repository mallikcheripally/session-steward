import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProviderSettings } from "../lib/settings.mjs";
import {
  createCodexHomeFixture,
  createLargeCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "./fixtures/claude-home.mjs";

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
  assert.match(output, /--archive-status <status>/u);
  assert.match(output, /--inactive-days <30\|60\|90>/u);
  assert.match(output, /--workspace <path>/u);
  assert.match(output, /--provider <codex\|claude-code>/u);
});

test("the terminal CLI lists Claude Code sessions from a one-time home", async (context) => {
  const fixture = await createClaudeHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-claude-"));
  context.after(async () => {
    await Promise.all([
      removeClaudeHomeFixture(fixture),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  const sessions = JSON.parse(await runCli([
    "--provider", "claude-code",
    "--claude-home", fixture.claudeHome,
    "--json",
  ], xdgConfigHome));
  assert.deepEqual(sessions.map(({ id }) => id).sort(), [fixture.cliId, fixture.unrelatedId].sort());
  assert.ok(sessions.every(({ providerId }) => providerId === "claude-code"));
});

test("the terminal CLI filters inactive sessions by exact workspace", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-filters-"));
  const otherWorkspace = path.join(fixture.codexHome, "another workspace");
  const database = new DatabaseSync(path.join(fixture.codexHome, "state_5.sqlite"));
  const now = Date.now();

  try {
    const update = database.prepare("update threads set cwd = ?, updated_at = ?, updated_at_ms = ? where id = ?");
    update.run(fixture.workspace, Math.floor(now / 1000), now, fixtureSessionIds.parent);
    const oldTimestamp = now - 100 * 24 * 60 * 60 * 1000;
    update.run(otherWorkspace, Math.floor(oldTimestamp / 1000), oldTimestamp, fixtureSessionIds.standalone);
  } finally {
    database.close();
  }

  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const sessions = JSON.parse(await runCli([
    "--codex-home",
    fixture.codexHome,
    "--json",
    "--include-internals",
    "--inactive-days",
    "90",
    "--workspace",
    otherWorkspace,
  ], xdgConfigHome));

  assert.deepEqual(sessions.map(({ id }) => id), [fixtureSessionIds.standalone]);

  await assert.rejects(
    runCli([
      "--codex-home",
      fixture.codexHome,
      "--json",
      "--inactive-days",
      "45",
    ], xdgConfigHome),
    (error) => error.stderr === "Inactive days must be 30, 60, or 90.\n",
  );
});

test("the terminal CLI filters archived sessions", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-archive-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const sessions = JSON.parse(await runCli([
    "--codex-home",
    fixture.codexHome,
    "--json",
    "--include-internals",
    "--archive-status",
    "archived",
  ], xdgConfigHome));

  assert.deepEqual(sessions.map(({ id }) => id), [fixtureSessionIds.standalone]);

  await assert.rejects(
    runCli([
      "--codex-home",
      fixture.codexHome,
      "--json",
      "--archive-status",
      "old",
    ], xdgConfigHome),
    (error) => error.stderr === "Archive status must be all, active, or archived.\n",
  );
});
