import assert from "node:assert/strict";
import test from "node:test";

import { updateSessionSteward } from "../lib/self-update.mjs";

function output(isTTY = false) {
  let text = "";
  return {
    isTTY,
    write(chunk) {
      text += chunk.toString();
    },
    get text() {
      return text;
    },
  };
}

test("update installs the latest release through npm", async () => {
  const calls = [];
  const stdout = output();
  const exitCode = await updateSessionSteward({
    currentVersion: "0.11.0",
    run: async (command, args) => {
      calls.push({ command, args });
      return {
        exitCode: 0,
        errorOutput: "",
        output: args[0] === "list"
          ? JSON.stringify({ dependencies: { "session-steward": { version: "0.12.0" } } })
          : "",
      };
    },
    stdout,
    stderr: output(),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    { command: "npm", args: ["install", "--global", "session-steward@latest"] },
    { command: "npm", args: ["list", "--global", "--depth=0", "--json", "session-steward"] },
  ]);
  assert.match(stdout.text, /Current version: 0\.11\.0/u);
  assert.match(stdout.text, /Updated version: 0\.12\.0/u);
});

test("an interactive permission error offers an explicit sudo retry", async () => {
  const calls = [];
  const stdout = output(true);
  let confirmed = 0;
  const exitCode = await updateSessionSteward({
    confirm: async () => {
      confirmed += 1;
      return true;
    },
    platform: "darwin",
    run: async (command, args) => {
      calls.push({ command, args });
      return calls.length === 1
        ? { exitCode: 243, errorOutput: "npm error code EACCES" }
        : {
          exitCode: 0,
          errorOutput: "",
          output: calls.length === 3
            ? JSON.stringify({ dependencies: { "session-steward": { version: "0.12.0" } } })
            : "",
        };
    },
    stdin: { isTTY: true },
    stdout,
    stderr: output(),
  });

  assert.equal(exitCode, 0);
  assert.equal(confirmed, 1);
  assert.deepEqual(calls[1], {
    command: "sudo",
    args: ["npm", "install", "--global", "session-steward@latest"],
  });
  assert.deepEqual(calls[2], {
    command: "sudo",
    args: ["npm", "list", "--global", "--depth=0", "--json", "session-steward"],
  });
  assert.match(stdout.text, /Updated version: 0\.12\.0/u);
});

test("a successful install does not claim an unverified version", async () => {
  const stderr = output();
  const stdout = output();
  const exitCode = await updateSessionSteward({
    run: async (_command, args) => ({
      exitCode: 0,
      errorOutput: "",
      output: args[0] === "list" ? "not JSON" : "",
    }),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout.text, /Updated version:/u);
  assert.match(stderr.text, /could not be confirmed/u);
});

test("a noninteractive permission error does not invoke sudo", async () => {
  const calls = [];
  const stderr = output();
  const exitCode = await updateSessionSteward({
    platform: "linux",
    run: async (command) => {
      calls.push(command);
      return { exitCode: 243, errorOutput: "npm error code EACCES" };
    },
    stdin: { isTTY: false },
    stdout: output(),
    stderr,
  });

  assert.equal(exitCode, 243);
  assert.deepEqual(calls, ["npm"]);
  assert.match(stderr.text, /sudo session-steward update/u);
});

test("declining sudo leaves the update failed", async () => {
  const calls = [];
  const exitCode = await updateSessionSteward({
    confirm: async () => false,
    platform: "darwin",
    run: async (command) => {
      calls.push(command);
      return { exitCode: 243, errorOutput: "npm error code EACCES" };
    },
    stdin: { isTTY: true },
    stdout: output(true),
    stderr: output(),
  });

  assert.equal(exitCode, 243);
  assert.deepEqual(calls, ["npm"]);
});

test("Windows permission errors point to an elevated terminal", async () => {
  const stderr = output();
  const exitCode = await updateSessionSteward({
    platform: "win32",
    run: async () => ({ exitCode: 1, errorOutput: "npm error code EPERM" }),
    stdin: { isTTY: true },
    stdout: output(true),
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text, /elevated terminal/u);
});

test("other npm failures do not trigger sudo", async () => {
  const calls = [];
  const exitCode = await updateSessionSteward({
    run: async (command) => {
      calls.push(command);
      return { exitCode: 1, errorOutput: "npm error code ENOTFOUND" };
    },
    stdin: { isTTY: true },
    stdout: output(true),
    stderr: output(),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ["npm"]);
});
