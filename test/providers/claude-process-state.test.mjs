import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { claudeProcessState, readClaudeProcessStart } from "../../lib/providers/claude-code/process-state.mjs";
import { getProvider } from "../../lib/providers/index.mjs";
import { runSessionCleanup } from "../../lib/session-cleanup.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");
const oldStart = "Mon Jan 1 00:00:00 2024";
const currentStart = "Tue Jan 2 00:00:00 2024";
const missingProcess = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };

test("Claude process checks distinguish exited, live, reused, and uncertain PIDs", async () => {
  const marker = { pid: 123, procStart: oldStart };
  const options = { platform: "darwin", kill: () => {}, readStart: async () => oldStart };
  assert.equal(await claudeProcessState(marker, options), "active");
  assert.equal(await claudeProcessState(marker, { ...options, kill: missingProcess }), "inactive");
  assert.equal(await claudeProcessState(marker, { ...options, readStart: async () => currentStart }), "inactive");
  assert.equal(await claudeProcessState(marker, { ...options, readStart: async () => null }), "unverified");
  assert.equal(await claudeProcessState(marker, { ...options, kill: () => {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  } }), "unverified");
  assert.equal(await claudeProcessState({ pid: 123 }, options), "active");
  assert.equal(await claudeProcessState({ ...marker, status: "completed" }, options), "active");
  assert.equal(await claudeProcessState({ ...marker, procStart: "invalid" }, options), "unverified");
  for (const pid of [undefined, "123", 0, 1, -2, 1.5, 2 ** 32]) {
    assert.equal(await claudeProcessState({ ...marker, pid }, { ...options, kill: () => assert.fail("invalid PID probed") }), "unverified");
  }
  assert.equal(await claudeProcessState({ ...marker, pidDomain: "elsewhere" }, {
    ...options, pidDomain: "darwin", kill: () => assert.fail("foreign PID probed"),
  }), "unverified");
});

test("Claude detects a process exiting during its start-time query", async () => {
  let exited = false;
  assert.equal(await claudeProcessState({ pid: 123, procStart: oldStart }, {
    platform: "linux",
    kill: () => { if (exited) missingProcess(); },
    readStart: async () => { exited = true; return null; },
  }), "inactive");
});

test("Windows uses procStartFt and does not confuse legacy procStart with FILETIME", async () => {
  const marker = { pid: 123, procStartFt: "134324640000000000" };
  const options = { platform: "win32", kill: () => {}, readStart: async () => marker.procStartFt };
  assert.equal(await claudeProcessState(marker, options), "active");
  assert.equal(await claudeProcessState(marker, { ...options, readStart: async () => "134324650000000000" }), "inactive");
  assert.equal(await claudeProcessState(marker, { ...options, readStart: async () => null }), "unverified");
  assert.equal(await claudeProcessState({ pid: 123, procStart: "legacy format" }, options), "active");
});

test("process start commands are bounded and use Claude's locale and timezone", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    let called = false;
    const result = await readClaudeProcessStart(123, { platform, run: async (command, args, options) => {
      called = true;
      assert.equal(options.timeout, 1000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.env.LC_ALL, "C");
      assert.equal(options.env.TZ, "UTC");
      if (platform === "win32") {
        assert.equal(command, "powershell.exe");
        assert.match(args.at(-1), /Get-Process -Id 123/u);
        assert.match(args.at(-1), /ToFileTimeUtc/u);
      } else {
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-o", "lstart=", "-p", "123"]);
      }
      return { stdout: `${oldStart}\n` };
    } });
    assert.equal(called, true);
    assert.equal(result, oldStart);
  }
  assert.equal(await readClaudeProcessStart(123, { run: async () => { throw new Error("timeout"); } }), null);
});

async function setup(context) {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const sessions = path.join(fixture.claudeHome, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  return { fixture, sessions, store, plan };
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

test("an exited Claude process marker no longer blocks cleanup and is left untouched", async (context) => {
  const { fixture, sessions, store, plan } = await setup(context);
  const pid = await exitedPid();
  const marker = path.join(sessions, `${pid}.json`);
  const contents = JSON.stringify({ pid, sessionId: fixture.cliId, procStart: oldStart });
  await fs.writeFile(marker, contents);
  const preflight = await claude.preflightSessionDeletion({ store, plan, scope: "core" });
  assert.equal(preflight.activeThreadDetection, "available");
  await claude.executeSessionDeletion({ store, plan, scope: "core" });
  assert.equal((await claude.verifySessionDeletion({ store, plan, scope: "core" })).complete, true);
  assert.equal(await fs.readFile(marker, "utf8"), contents);
});

test("a real live Claude marker protects the selected session, including legacy filename PIDs", async (context) => {
  const { fixture, sessions, store, plan } = await setup(context);
  const start = await readClaudeProcessStart(process.pid);
  assert.ok(start, "the platform's process-start query must work");
  const marker = path.join(sessions, `${process.pid}.json`);
  const identity = process.platform === "win32" ? { procStartFt: start } : { procStart: start };
  await fs.writeFile(marker, JSON.stringify({ sessionId: fixture.cliId, ...identity }));
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Close the selected Claude/u);
  const previous = process.platform === "win32" ? { procStartFt: "132537600000000000" } : { procStart: oldStart };
  await fs.writeFile(marker, JSON.stringify({ pid: process.pid, sessionId: fixture.cliId, ...previous }));
  await claude.preflightSessionDeletion({ store, plan, scope: "core" });
});

test("unrelated live sessions do not block selected cleanup", async (context) => {
  const { fixture, sessions, store, plan } = await setup(context);
  await fs.writeFile(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fixture.unrelatedId }));
  await claude.preflightSessionDeletion({ store, plan, scope: "core" });
});

test("legacy terminal markers are not treated as open solely because of their filenames", async (context) => {
  const { fixture, sessions, store, plan } = await setup(context);
  const marker = path.join(sessions, `${fixture.cliId}.json`);
  await fs.writeFile(marker, JSON.stringify({ session_id: fixture.cliId, status: "completed" }));
  await claude.preflightSessionDeletion({ store, plan, scope: "core" });
  await fs.writeFile(marker, JSON.stringify({ session_id: fixture.cliId }));
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Could not verify/u);
  await fs.writeFile(marker, "incomplete JSON");
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Could not verify/u);
  await fs.writeFile(marker, JSON.stringify({ sessionId: fixture.unrelatedId }));
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Could not verify/u);
});

test("unreadable registry and contradictory PID metadata fail closed", async (context) => {
  const { fixture, sessions, store, plan } = await setup(context);
  await fs.writeFile(path.join(sessions, "123.json"), JSON.stringify({ pid: process.pid, sessionId: fixture.cliId }));
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Could not verify/u);
  await fs.unlink(path.join(sessions, "123.json"));
  const readdir = fs.readdir;
  context.mock.method(fs, "readdir", async (target, options) => {
    if (target === sessions) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return readdir(target, options);
  });
  await assert.rejects(claude.preflightSessionDeletion({ store, plan, scope: "core" }), /Could not verify/u);
});

test("a Claude session opened during backup stops before mutation or automatic restore", async (context) => {
  const { fixture, sessions } = await setup(context);
  const historyPath = path.join(fixture.claudeHome, "history.jsonl");
  const history = await fs.readFile(historyPath);
  const transcript = await fs.readFile(fixture.cliTranscript);
  let restored = false;
  const provider = { ...claude, restoreSessionDeletionBackup: async () => { restored = true; assert.fail("must not restore over a live session"); } };
  await assert.rejects(runSessionCleanup({
    provider, options: fixture, recordIds: [fixture.cliId], scope: "core",
    onProgress: ({ phase }) => {
      if (phase === "cleanup") writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fixture.cliId }));
    },
  }), /Close the selected Claude/u);
  assert.equal(restored, false);
  assert.deepEqual(await fs.readFile(historyPath), history);
  assert.deepEqual(await fs.readFile(fixture.cliTranscript), transcript);
  assert.deepEqual(await claude.listSessionDeletionBackups(fixture), []);
  await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
});
