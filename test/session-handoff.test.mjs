import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createSessionHandoff, desktopHandoffLink, HANDOFF_DIRECTORY } from "../lib/session-handoff.mjs";
import { desktopLaunchInvocation, openDesktopHandoff } from "../lib/handoff-launch.mjs";
import { createCodexHomeFixture, fixtureSessionIds } from "./fixtures/codex-home.mjs";
import { createClaudeHomeFixture } from "./fixtures/claude-home.mjs";

const line = value => `${JSON.stringify(value)}\n`;
function codexMessage(text, role = "user") {
  return { type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } };
}
async function fixture(context, options) {
  const value = await createCodexHomeFixture(options);
  context.after(() => fs.rm(value.codexHome, { recursive: true, force: true }));
  await fs.appendFile(value.transcripts.parent, line(codexMessage("Keep the early constraint 東京 🙂 and do not publish.")));
  return value;
}
const exportCodex = (value, extra = {}) => createSessionHandoff({ providerId: "codex", providerHome: value.codexHome, id: fixtureSessionIds.parent, target: "claude", ...extra });
async function archive(result) {
  const names = (await fs.readdir(path.join(result.directory, "history"))).sort();
  return (await Promise.all(names.map(name => fs.readFile(path.join(result.directory, "history", name), "utf8")))).join("");
}

for (const layout of ["state_5", "state_6"]) {
  test(`Codex ${layout} hands off using the existing parser and never changes source files`, async context => {
    const value = await fixture(context, { layout });
    const before = await fs.readFile(value.transcripts.parent);
    const result = await exportCodex(value);
    assert.equal(result.partial, false);
    assert.match(await archive(result), /Keep the early constraint 東京 🙂/);
    assert.deepEqual(await fs.readFile(value.transcripts.parent), before);
    assert.equal(await fs.readFile(path.join(value.workspace, HANDOFF_DIRECTORY, ".gitignore"), "utf8"), "*\n");
    assert.equal(new URL(result.launchUrl).pathname, "/new");
    assert.equal(new URL(result.launchUrl).searchParams.get("folder"), await fs.realpath(value.workspace));
    assert.ok((await fs.stat(result.startPath)).size < 8192);
  });
}

for (const layout of ["current", "alternate"]) {
  test(`Claude ${layout} uses its selected transcript and an explicitly relocated project folder`, async context => {
    const value = await createClaudeHomeFixture({ layout });
    context.after(() => fs.rm(value.root, { recursive: true, force: true }));
    const result = await createSessionHandoff({ providerId: "claude-code", providerHome: value.claudeHome, desktopDataHome: value.desktopDataHome, id: value.cliId, workspace: value.root, target: "chatgpt" });
    assert.equal(result.partial, false);
    assert.equal(new URL(result.launchUrl).protocol, "codex:");
    assert.match(await archive(result), /Refactor the authentication boundary/);
    assert.ok(!(await archive(result)).includes("unrelated"));
    const manifest = JSON.parse(await fs.readFile(path.join(result.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.recordedWorkspace, "/workspace/demo");
    assert.equal(manifest.workspace, await fs.realpath(value.root));
  });
}

test("Claude 2.1.332 recorded history exports its request and reply without copying API metadata", async context => {
  const value = await createClaudeHomeFixture();
  context.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const recorded = await fs.readFile(new URL("./fixtures/claude-2.1.332.jsonl", import.meta.url), "utf8");
  await fs.writeFile(value.cliTranscript, recorded.replaceAll("44444444-4444-4444-8444-444444444444", value.cliId));
  const result = await createSessionHandoff({ providerId: "claude-code", providerHome: value.claudeHome, desktopDataHome: value.desktopDataHome, id: value.cliId, workspace: value.root, target: "chatgpt" });
  assert.equal(result.partial, false);
  const history = await archive(result);
  assert.match(history, /Compatibility fixture request/);
  assert.match(history, /Compatibility fixture response/);
  assert.ok(!history.includes("requestDigest"));
});

test("full export preserves early corrections beyond the timeline cap and streams a paged index", async context => {
  const value = await fixture(context);
  const handle = await fs.open(value.transcripts.parent, "a");
  for (let start = 0; start < 25000; start += 100) {
    await handle.write(Array.from({ length: 100 }, (_, offset) => line(codexMessage(`Inspection ${start + offset}: ${"ordinary archive material ".repeat(20)}`, "assistant"))).join(""));
  }
  await handle.write(line(codexMessage("Late correction: keep every early constraint, retention is now 14 days.")));
  await handle.close();
  const result = await exportCodex(value);
  assert.equal(result.eventCount, 25002);
  assert.ok(result.chunkCount > 100);
  const text = await archive(result);
  assert.match(text, /early constraint 東京 🙂/);
  assert.match(text, /retention is now 14 days/);
  assert.ok(!text.includes("\uFFFD"));
  assert.ok((await fs.stat(result.startPath)).size < 8192);
  const pages = await fs.readdir(path.join(result.directory, "index"));
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok((await fs.readFile(path.join(result.directory, "index", page), "utf8")).split("\n").filter(row => row.startsWith("- ")).length <= 100);
  for (const file of await fs.readdir(path.join(result.directory, "history"))) assert.ok((await fs.stat(path.join(result.directory, "history", file))).size <= 64 * 1024);
});

test("a very long Unicode request keeps the starting file small while preserving its full history", async context => {
  const value = await fixture(context);
  const text = `Continue this work: ${"東京🙂".repeat(10000)} FULL_REQUEST_END_CANARY`;
  await fs.appendFile(value.transcripts.parent, line(codexMessage(text)));
  const result = await exportCodex(value);
  assert.ok((await fs.stat(result.startPath)).size < 8192);
  assert.match(await fs.readFile(result.startPath, "utf8"), /excerpt; read the full record/);
  assert.ok((await archive(result)).includes(text));
});

test("recorded tool results and patch arguments are retained rather than inferred from a command", async context => {
  const value = await fixture(context);
  await fs.appendFile(value.transcripts.parent, [
    line({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "run", arguments: JSON.stringify({ cmd: "node --test regression.test.mjs" }) } }),
    line({ type: "response_item", payload: { type: "function_call_output", call_id: "run", output: "Process exited with code 1\nREGRESSION_FAILURE_CANARY" } }),
    line({ type: "response_item", payload: { type: "function_call_output", call_id: "explicit-status", exit_code: 7, is_error: true, output: "Output without a textual status" } }),
    line({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: "*** Begin Patch\n*** Update File: retry.mjs\n-old\n+NEW_PATCH_CANARY\n*** End Patch" } }),
  ].join(""));
  const result = await exportCodex(value);
  const text = await archive(result);
  assert.match(text, /REGRESSION_FAILURE_CANARY/);
  assert.match(text, /Process exited with code 1/);
  assert.match(text, /Recorded exit code: 7/);
  assert.match(text, /Recorded error flag: true/);
  assert.match(text, /NEW_PATCH_CANARY/);
  assert.match(text, /node --test regression.test.mjs/);
});

test("unknown and malformed records produce a clearly partial archive", async context => {
  const value = await fixture(context);
  await fs.appendFile(value.transcripts.parent, `${line({ type: "future-sensitive-type", payload: { text: "UNRECOGNIZED_CANARY" } })}{broken\n`);
  const result = await exportCodex(value);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(warning => warning.includes("1 unknown, 1 malformed")));
  assert.ok(!(await archive(result)).includes("UNRECOGNIZED_CANARY"));
});

test("current Codex tool inventories and token bookkeeping do not become missing conversation records", async context => {
  const value = await fixture(context);
  await fs.appendFile(value.transcripts.parent, [
    { type: "response_item", payload: { type: "additional_tools", role: "developer", tools: [{ name: "example" }] } },
    { type: "token_usage_record", payload: { usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } },
  ].map(line).join(""));
  const result = await exportCodex(value);
  assert.equal(result.partial, false);
  assert.deepEqual(result.warnings, []);
  const text = await archive(result);
  assert.match(text, /early constraint/);
  assert.ok(!text.includes("additional_tools"));
  await fs.appendFile(value.transcripts.parent, line({ type: "event_msg", payload: { type: "item_completed", item: { type: "FutureUnknownItem", text: "Do not silently discard unsupported context." } } }));
  assert.equal((await exportCodex(value)).partial, true);
});

test("oversized records and binary attachments are reported before a destination can open", async context => {
  const value = await fixture(context);
  await fs.appendFile(value.transcripts.parent, line(codexMessage("x".repeat(8 * 1024 * 1024 + 1), "assistant")));
  await fs.appendFile(value.transcripts.parent, line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "See the attached image." }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] } }));
  const result = await exportCodex(value);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(warning => warning.includes("1 oversized")));
  assert.ok(result.warnings.some(warning => warning.includes("attachments are not included")));
});

test("generated handoff data is ignored by Git without modifying repository ignore settings", async context => {
  const value = await fixture(context);
  const execute = promisify(execFile);
  await execute("git", ["init", "--quiet", value.workspace]);
  const result = await exportCodex(value);
  const { stdout } = await execute("git", ["-C", value.workspace, "status", "--porcelain", "--untracked-files=all"]);
  assert.equal(stdout, "");
  await fs.access(result.startPath);
  await assert.rejects(fs.access(path.join(value.workspace, ".gitignore")), { code: "ENOENT" });
});

test("a stale catalog pointing at another session is rejected and leaves no published archive", async context => {
  const value = await fixture(context);
  await fs.writeFile(value.transcripts.parent, line({ type: "session_meta", payload: { id: "other-session", cwd: value.workspace } }) + line(codexMessage("wrong source")));
  await assert.rejects(exportCodex(value), { code: "HANDOFF_ID_MISMATCH" });
  assert.deepEqual(await fs.readdir(path.join(value.workspace, HANDOFF_DIRECTORY)), [".gitignore"]);
});

test("missing source, missing workspace, cancellation and source limits cannot launch or publish an archive", async context => {
  const value = await fixture(context);
  await assert.rejects(exportCodex(value, { target: "invalid" }), { code: "HANDOFF_INVALID_TARGET" });
  await assert.rejects(exportCodex(value, { workspace: path.join(value.workspace, "missing") }), { code: "HANDOFF_WORKSPACE_REQUIRED" });
  await assert.rejects(exportCodex(value, { maxExportBytes: 1 }), { code: "HANDOFF_TOO_LARGE" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportCodex(value, { signal: controller.signal }), { code: "HANDOFF_CANCELLED" });
  await fs.unlink(value.transcripts.parent);
  await assert.rejects(exportCodex(value));
});

test("a linked output folder is refused", { skip: process.platform === "win32" }, async context => {
  const value = await fixture(context);
  await fs.symlink(value.codexHome, path.join(value.workspace, HANDOFF_DIRECTORY));
  await assert.rejects(exportCodex(value), { code: "HANDOFF_UNSAFE_PATH" });
});

test("unexpected ignore rules are never overwritten", async context => {
  const value = await fixture(context);
  const root = path.join(value.workspace, HANDOFF_DIRECTORY);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, ".gitignore"), "do not overwrite\n");
  await assert.rejects(exportCodex(value), { code: "HANDOFF_UNSAFE_PATH" });
  assert.equal(await fs.readFile(path.join(root, ".gitignore"), "utf8"), "do not overwrite\n");
});

test("a source changed during the snapshot is explicitly partial", async context => {
  const value = await fixture(context);
  let calls = 0;
  const result = await exportCodex(value, { now: () => {
    if (++calls === 3) appendFileSync(value.transcripts.parent, line(codexMessage("new activity")));
    return Date.now();
  } });
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some(warning => warning.includes("source changed")));
});

test("desktop links safely encode paths and prompts for both apps", () => {
  const workspace = "C:\\project with & symbols\\東京";
  const prompt = 'Read "history" & continue 100% #task';
  for (const target of ["chatgpt", "claude"]) {
    const url = desktopHandoffLink({ target, workspace, prompt });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get(target === "chatgpt" ? "path" : "folder"), workspace);
    assert.equal(parsed.searchParams.get(target === "chatgpt" ? "prompt" : "q"), prompt);
    for (const platform of ["darwin", "linux", "win32"]) {
      const invocation = desktopLaunchInvocation(url, { platform });
      assert.equal(invocation.args.at(-1), url);
      assert.notEqual(invocation.command, "cmd.exe");
    }
  }
  assert.throws(() => desktopLaunchInvocation("https://example.com"));
});

test("desktop opener reports missing handlers and preserves the handoff for retry", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 1));
    return child;
  };
  const handoff = { launchUrl: desktopHandoffLink({ target: "claude", workspace: "/project", prompt: "Read local history" }) };
  await assert.rejects(openDesktopHandoff(handoff, { platform: "darwin", spawnProcess }), /could not be opened/);
  assert.equal(calls[0].command, "open");
});
