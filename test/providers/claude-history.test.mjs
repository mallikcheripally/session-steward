import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";

import { getProvider } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");

async function setup(context) {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const historyPath = path.join(fixture.claudeHome, "history.jsonl");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  return { fixture, historyPath, plan, store };
}

// A separate process using Claude 2.1.263's actual history-lock protocol.
// The handshake puts its append precisely in the old EOF-to-rename race.
async function historyWriter(context, historyPath, sessionId) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { promises as fs } from 'node:fs';
    import lockfile from ${JSON.stringify(import.meta.resolve("proper-lockfile"))};
    process.on('message', async () => {
      let release;
      let reply;
      try {
        release = await lockfile.lock(process.argv[1], { stale: 10000, retries: 0 });
        await fs.appendFile(process.argv[1], JSON.stringify({
          sessionId: process.argv[2], display: 'concurrent unrelated prompt', timestamp: 42,
        }) + '\\n');
        reply = 'written';
      } catch (error) { reply = error.code ?? error.message; }
      finally { await release?.(); }
      process.send(reply);
    });
    process.send('ready');
  `, historyPath, sessionId], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  context.after(() => child.kill());
  assert.equal((await once(child, "message"))[0], "ready");
  return async () => {
    const reply = once(child, "message");
    child.send("append");
    return (await reply)[0];
  };
}

for (const operation of ["cleanup", "restore"]) {
  test(`Claude ${operation} preserves another process's prompt at history replacement`, { timeout: 15_000 }, async (context) => {
    const { fixture, historyPath, plan, store } = await setup(context);
    const deletion = operation === "restore"
      ? await claude.executeSessionDeletion({ plan, scope: "core", store })
      : null;
    const append = await historyWriter(context, historyPath, fixture.unrelatedId);
    const rename = fs.rename;
    let replacements = 0;
    context.mock.method(fs, "rename", async (source, destination) => {
      if (destination === historyPath) {
        replacements += 1;
        assert.equal(await append(), "ELOCKED", "Claude must not append to the file about to be replaced");
      }
      return rename(source, destination);
    });
    if (operation === "cleanup") {
      await claude.executeSessionDeletion({ plan, scope: "core", store });
      assert.equal((await claude.verifySessionDeletion({ plan, scope: "core", store })).complete, true);
    } else {
      await claude.restoreSessionDeletionBackup({ ...fixture, backupDirectory: deletion.backupDirectory });
    }
    assert.equal(replacements, 1);
    assert.equal(await append(), "written", "the writer can retry after the history transaction");
    const history = await fs.readFile(historyPath, "utf8");
    assert.match(history, /concurrent unrelated prompt/u);
    assert.equal(history.includes(fixture.cliId), operation === "restore");
    await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
  });
}

test("Claude cleanup stops before mutation when native history is busy", async (context) => {
  const { fixture, historyPath, plan, store } = await setup(context);
  const before = await fs.readFile(historyPath);
  const release = await lockfile.lock(historyPath, { stale: 10_000 });
  try {
    await assert.rejects(claude.executeSessionDeletion({ plan, scope: "deep", store }), (error) => {
      assert.match(error.message, /prompt history is busy/u);
      assert.equal(error.mutationStarted, false);
      return true;
    });
    assert.deepEqual(await fs.readFile(historyPath), before);
    await fs.access(fixture.cliTranscript);
    assert.equal(await lockfile.check(historyPath), true);
    assert.equal((await claude.diagnoseStorageCompatibility(fixture)).status, "ready");
  } finally {
    await release();
  }
  await claude.executeSessionDeletion({ plan, scope: "deep", store });
  assert.equal((await claude.verifySessionDeletion({ plan, scope: "deep", store })).complete, true);
});

test("Claude cleanup recovers a stale native history lock", async (context) => {
  const { historyPath, plan, store } = await setup(context);
  await fs.mkdir(`${historyPath}.lock`);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(`${historyPath}.lock`, old, old);
  await claude.executeSessionDeletion({ plan, scope: "core", store });
  await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
});

for (const failure of ["cancel", "rename"]) {
  test(`Claude releases the history lock on ${failure} failure`, async (context) => {
    const { fixture, historyPath, plan, store } = await setup(context);
    const before = await fs.readFile(historyPath);
    if (failure === "rename") {
      const rename = fs.rename;
      context.mock.method(fs, "rename", async (source, destination) => {
        if (destination === historyPath) throw new Error("injected rename failure");
        return rename(source, destination);
      });
    }
    await assert.rejects(claude.executeSessionDeletion({
      plan, scope: "core", store, shouldCancel: () => failure === "cancel",
    }), failure === "cancel" ? /cancelled/u : /injected rename failure/u);
    assert.deepEqual(await fs.readFile(historyPath), before);
    await fs.access(fixture.cliTranscript);
    await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
    assert.equal((await fs.readdir(fixture.claudeHome)).some((name) => name.startsWith("history.jsonl.tmp-")), false);
  });
}

test("Claude refuses to replace history after its lock is compromised", async (context) => {
  const { historyPath, plan, store } = await setup(context);
  const before = await fs.readFile(historyPath);
  const lock = lockfile.lock;
  let compromise;
  let release;
  let rewriting = false;
  const stat = fs.stat;
  context.mock.method(fs, "stat", async (target, ...args) => {
    if (target === historyPath && rewriting) compromise(new Error("injected loss of ownership"));
    return stat(target, ...args);
  });
  context.mock.method(lockfile, "lock", async (target, options) => {
    compromise = options.onCompromised;
    release = await lock(target, options);
    return release;
  });
  try {
    await assert.rejects(claude.executeSessionDeletion({
      plan, scope: "core", store,
      onProgress: ({ phase }) => {
        if (phase === "cleanup") rewriting = true;
      },
    }), /prompt-history lock was lost/u);
    assert.deepEqual(await fs.readFile(historyPath), before);
  } finally {
    // The test injected the notification; the real library already releases
    // its internal ownership when invoking onCompromised.
    await release?.();
  }
});

test("Claude restore locks a missing history file and preserves malformed unrelated rows", async (context) => {
  const { fixture, historyPath, plan, store } = await setup(context);
  await fs.appendFile(historyPath, "not-json\n");
  const deletion = await claude.executeSessionDeletion({ plan, scope: "core", store });
  assert.match(await fs.readFile(historyPath, "utf8"), /not-json/u);
  await fs.unlink(historyPath);
  await claude.restoreSessionDeletionBackup({ ...fixture, backupDirectory: deletion.backupDirectory });
  assert.match(await fs.readFile(historyPath, "utf8"), new RegExp(fixture.cliId));
  await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
});

test("Claude history locking does not hide backup failures or leak a lock", async (context) => {
  const { historyPath, plan, store } = await setup(context);
  const before = await fs.readFile(historyPath);
  const writeFile = fs.writeFile;
  context.mock.method(fs, "writeFile", async (target, ...args) => {
    if (path.basename(target) === "manifest.json") throw new Error("injected manifest failure");
    return writeFile(target, ...args);
  });
  await assert.rejects(claude.executeSessionDeletion({ plan, scope: "core", store }), (error) => {
    assert.match(error.message, /injected manifest failure/u);
    assert.equal(error.mutationStarted, false);
    assert.ok(error.backupDirectory);
    return true;
  });
  assert.deepEqual(await fs.readFile(historyPath), before);
  await assert.rejects(fs.stat(`${historyPath}.lock`), { code: "ENOENT" });
});
