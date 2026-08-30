import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProviderSettings } from "../lib/settings.mjs";
import { getProvider } from "../lib/providers/index.mjs";
import { acquireSessionMutationLock } from "../lib/session-cleanup.mjs";
import { queryRows } from "../lib/storage/sqlite.mjs";
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
  const { stdout } = await runCliResult(args, xdgConfigHome);
  return stdout;
}

async function runCliResult(args, xdgConfigHome) {
  return executeFile(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome },
  });
}

async function runInteractiveCli(args, steps, xdgConfigHome) {
  return (await runInteractiveCliResult(args, steps, xdgConfigHome)).stdout;
}

async function runInteractiveCliResult(args, steps, xdgConfigHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome },
    });
    let stdout = "";
    let stderr = "";
    let nextStep = 0;
    let searchFrom = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("The interactive CLI test timed out."), { stderr, stdout }));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;

      while (nextStep < steps.length) {
        const step = steps[nextStep];
        const promptIndex = stdout.indexOf(step.prompt, searchFrom);
        if (promptIndex < 0) break;
        searchFrom = promptIndex + step.prompt.length;
        nextStep += 1;
        child.stdin.write(`${step.response}\n`);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stderr, stdout });
      else reject(Object.assign(new Error(stderr || `CLI exited with code ${code}.`), { stderr, stdout }));
    });
  });
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

test("active provider settings persist and invalid values fall back to Codex", async (context) => {
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-active-provider-"));
  const configDirectory = path.join(xdgConfigHome, "session-steward");
  const configPath = path.join(configDirectory, "config.json");
  context.after(() => fs.rm(xdgConfigHome, { force: true, recursive: true }));
  let settings = await createProviderSettings({ configDirectory });
  assert.equal(settings.getActiveProviderId(), "codex");
  await settings.setActiveProviderId("claude-code");
  settings = await createProviderSettings({ configDirectory });
  assert.equal(settings.getActiveProviderId(), "claude-code");

  for (const activeProviderId of ["future-provider", 42, null]) {
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ activeProviderId, providers: {}, version: 1 })}\n`,
    );
    settings = await createProviderSettings({ configDirectory });
    assert.equal(settings.getActiveProviderId(), "codex");
  }
});

test("the terminal CLI honors the saved provider while an explicit provider wins", async (context) => {
  const claudeFixture = await createClaudeHomeFixture();
  const codexFixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-provider-"));
  const settings = await createProviderSettings({
    configDirectory: path.join(xdgConfigHome, "session-steward"),
  });
  context.after(async () => {
    await Promise.all([
      removeClaudeHomeFixture(claudeFixture),
      removeCodexHomeFixture(codexFixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await settings.setProviderHome("claude-code", claudeFixture.claudeHome);
  await settings.setActiveProviderId("claude-code");

  const savedSessions = JSON.parse(await runCli(["--json"], xdgConfigHome));
  assert.ok(savedSessions.every(({ providerId }) => providerId === "claude-code"));

  const explicitSessions = JSON.parse(await runCli([
    "--provider", "codex",
    "--codex-home", codexFixture.codexHome,
    "--json",
    "--include-internals",
  ], xdgConfigHome));
  assert.ok(explicitSessions.every(({ providerId }) => providerId === "codex"));
});

test("help does not read provider settings", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-help-"));
  const unusableConfigHome = path.join(directory, "not-a-directory");
  await fs.writeFile(unusableConfigHome, "This is a file.", "utf8");
  context.after(() => fs.rm(directory, { force: true, recursive: true }));

  const output = await runCli(["--help"], unusableConfigHome);
  assert.match(output, /^Usage: session-steward-cli/u);
  assert.match(output, /--archive-status <status>/u);
  assert.match(output, /--inactive-days <days>/u);
  assert.match(output, /--workspace <path>/u);
  assert.match(output, /--provider <codex\|claude-code>/u);
  assert.match(output, /--include-supporting/u);
  assert.match(output, /--cleanup <standard\|thorough>/u);
  assert.match(output, /--overview/u);
  assert.match(output, /--backups/u);
  assert.match(output, /--events/u);
  assert.match(output, /--events-limit <number>/u);
});

test("JSON event inspection preserves session fields and adds distilled output", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-events-json-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await fs.appendFile(fixture.transcripts.parent, `${JSON.stringify({
    payload: {
      content: [{ text: "Review the cleanup flow" }],
      role: "user",
      type: "message",
    },
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "response_item",
  })}\n`);

  const plain = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--include-internals",
    "--json",
    "--limit", "1",
  ], xdgConfigHome));
  const result = await runCliResult([
    "--codex-home", fixture.codexHome,
    "--events",
    "--events-limit", "1",
    "--include-internals",
    "--json",
    "--limit", "1",
  ], xdgConfigHome);
  const enriched = JSON.parse(result.stdout);

  for (const [key, value] of Object.entries(plain[0])) {
    assert.deepEqual(enriched[0][key], value);
  }
  assert.deepEqual(enriched[0].events.map(({ text }) => text), ["Review the cleanup flow"]);
  assert.equal(enriched[0].coverage.total, 2);
  assert.equal(enriched[0].header.provider, "codex");
  assert.deepEqual(enriched[0].summary, { asks: 1, commands: 0, edits: 0 });
  assert.equal(result.stderr, "");
});

function tokenCountRecord(total, last) {
  return `${JSON.stringify({
    payload: {
      info: { last_token_usage: last, model_context_window: 258_400, total_token_usage: total },
      type: "token_count",
    },
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "event_msg",
  })}\n`;
}

function tokenUsage({ cached = 0, input = 0, output = 0, reasoning = 0 }) {
  return {
    cache_write_input_tokens: 0,
    cached_input_tokens: cached,
    input_tokens: input,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function appendTokenEvents(transcriptPath) {
  const turn = tokenUsage({ cached: 6000, input: 9000, output: 1000, reasoning: 400 });
  await fs.appendFile(transcriptPath, [
    tokenCountRecord(tokenUsage({ cached: 6000, input: 9000, output: 1000 }), turn),
    // Re-emitted: the running total does not move, so it is not a second turn.
    tokenCountRecord(tokenUsage({ cached: 6000, input: 9000, output: 1000 }), turn),
    tokenCountRecord(tokenUsage({ cached: 12_000, input: 18_000, output: 2000 }), turn),
  ].join(""));
}

test("JSON output carries token usage when asked, and leaves it out otherwise", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-tokens-json-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await appendTokenEvents(fixture.transcripts.parent);

  const plain = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--include-internals",
    "--json",
  ], xdgConfigHome));
  assert.equal(plain.every((record) => record.tokens === undefined), true);

  const enriched = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--include-internals",
    "--json",
    "--tokens",
  ], xdgConfigHome));
  const parent = enriched.find(({ id }) => id === fixtureSessionIds.parent);

  assert.equal(parent.tokens.available, true);
  // Two turns of 10,000, not three: the re-emitted event is not new spend.
  assert.equal(parent.tokens.total, 20_000);
  assert.equal(parent.tokens.segments.reduce((sum, { tokens }) => sum + tokens, 0), 20_000);
  assert.deepEqual(
    Object.fromEntries(parent.tokens.segments.map(({ key, tokens }) => [key, tokens])),
    { cacheWrites: 0, cachedInput: 12_000, freshInput: 6000, output: 2000 },
  );
  assert.equal(parent.tokens.reasoning.tokens, 800);
  assert.equal(parent.tokens.cacheHitRate, 12_000 / 18_000);
});

test("interactive inspection prints token usage only once the toggle is on", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-tokens-text-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await appendTokenEvents(fixture.transcripts.parent);

  const withoutToggle = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals"],
    [
      { prompt: "session-steward> ", response: "inspect 1" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );
  assert.equal(withoutToggle.includes("Token usage"), false);

  const withToggle = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals", "--tokens"],
    [
      { prompt: "session-steward> ", response: "inspect 1" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );
  assert.match(withToggle, /Token usage/u);
  assert.match(withToggle, /Total: 20\.0K/u);
  assert.match(withToggle, /Cached input: 12\.0K \(60%\)/u);
  assert.match(withToggle, /Reasoning: 800 \(40% of output\)/u);
  assert.match(withToggle, /Cache hits: 67% of input/u);
});

test("the tokens toggle turns the breakdown on from inside the session", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-tokens-toggle-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await appendTokenEvents(fixture.transcripts.parent);

  const result = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals"],
    [
      { prompt: "session-steward> ", response: "tokens" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "inspect 1" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(result, /Token usage in session details is on\./u);
  assert.match(result, /Tokens: shown/u);
  assert.match(result, /Total: 20\.0K/u);
});

test("text event inspection prints the full-session activity summary", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-events-summary-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  await fs.appendFile(fixture.transcripts.parent, `${JSON.stringify({
    payload: {
      content: [{ text: "Review the cleanup flow" }],
      role: "user",
      type: "message",
    },
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "response_item",
  })}\n`);

  const result = await runInteractiveCliResult(
    ["--codex-home", fixture.codexHome, "--events", "--include-internals"],
    [
      { prompt: "session-steward> ", response: "inspect 1" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(result.stderr, /^1 ask · 0 edits · 0 commands\nrecognized \d+% · \d+ skipped/u);
});

test("text event inspection distinguishes transcript states and sends coverage to stderr", async (context) => {
  const cases = [
    {
      expected: "No recognized session events were found.",
      prepare: async () => {},
    },
    {
      expected: "The transcript file is missing.",
      prepare: async (fixture) => fs.rm(fixture.transcripts.parent),
    },
    {
      expected: "No transcript path was recorded for this session.",
      prepare: async (fixture) => {
        const database = new DatabaseSync(fixture.stateDatabasePath);
        try {
          database.prepare("update threads set rollout_path = null where id = ?").run(fixtureSessionIds.parent);
        } finally {
          database.close();
        }
      },
    },
  ];

  for (const testCase of cases) {
    await context.test(testCase.expected, async (subcontext) => {
      const fixture = await createCodexHomeFixture();
      const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-events-text-"));
      subcontext.after(async () => {
        await Promise.all([
          removeCodexHomeFixture(fixture.codexHome),
          fs.rm(xdgConfigHome, { force: true, recursive: true }),
        ]);
      });
      await testCase.prepare(fixture);

      const result = await runInteractiveCliResult(
        ["--codex-home", fixture.codexHome, "--events", "--include-internals"],
        [
          { prompt: "session-steward> ", response: "inspect 1" },
          { prompt: "Press Enter to continue...", response: "" },
          { prompt: "session-steward> ", response: "quit" },
        ],
        xdgConfigHome,
      );

      assert.match(result.stdout, new RegExp(testCase.expected.replaceAll(".", "\\."), "u"));
      assert.match(result.stderr, /^recognized \d+% · \d+ skipped/u);
      assert.doesNotMatch(result.stdout, /recognized \d+% · \d+ skipped/u);
    });
  }
});

test("the terminal CLI reports overview and recovery backups as JSON", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-overview-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const overview = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--overview",
    "--json",
  ], xdgConfigHome));
  assert.equal(overview.sessionCount, 3);
  assert.equal(overview.transcriptBytes > 0, true);
  assert.equal(overview.transcriptFileCount, 3);

  const codex = getProvider("codex");
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.standalone],
  });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.standalone],
    store,
  });
  const cleanup = await codex.executeSessionDeletion({ plan, scope: "core", store });
  const backups = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--backups",
    "--json",
  ], xdgConfigHome));

  assert.equal(backups.length, 1);
  assert.equal(backups[0].backupDirectory, cleanup.backupDirectory);
  assert.equal(backups[0].restorable, true);
  assert.equal(backups[0].scope, "core");
});

test("the interactive CLI defaults to thorough cleanup and removes verified backups", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-standard-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals"],
    [
      { prompt: "session-steward> ", response: `delete ${fixtureSessionIds.parent.slice(0, 12)}` },
      { prompt: 'to confirm: ', response: "DELETE 2" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /Cleanup: Thorough/u);
  assert.match(output, /Deleted and verified 2 sessions/u);
  assert.equal(
    queryRows(path.join(fixture.codexHome, "memories_1.sqlite"), "select count(*) as count from stage1_outputs")[0].count,
    0,
  );
  assert.equal(
    queryRows(path.join(fixture.codexHome, "goals_1.sqlite"), "select count(*) as count from thread_goals")[0].count,
    0,
  );
  const provider = getProvider("codex");
  assert.deepEqual(await provider.listSessionDeletionBackups({ codexHome: fixture.codexHome }), []);
});

test("the interactive CLI respects a provider lock owned by another process", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-lock-"));
  const provider = getProvider("codex");
  const release = await acquireSessionMutationLock({
    options: { codexHome: fixture.codexHome },
    provider,
  });
  context.after(async () => {
    await release().catch(() => {});
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome],
    [
      { prompt: "session-steward> ", response: `delete ${fixtureSessionIds.standalone}` },
      { prompt: 'to confirm: ', response: "DELETE" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /already using this Codex folder/u);
  assert.equal((await provider.getSessionRecord({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.standalone,
  })).id, fixtureSessionIds.standalone);
});

test("the interactive CLI runs standard cleanup only when requested", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-thorough-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals", "--cleanup", "standard"],
    [
      { prompt: "session-steward> ", response: `delete ${fixtureSessionIds.parent}` },
      { prompt: 'to confirm: ', response: "DELETE 2" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /Cleanup: Standard/u);
  assert.equal(
    queryRows(path.join(fixture.codexHome, "memories_1.sqlite"), "select count(*) as count from stage1_outputs")[0].count,
    2,
  );
  assert.equal(
    queryRows(path.join(fixture.codexHome, "goals_1.sqlite"), "select count(*) as count from thread_goals")[0].count,
    2,
  );
});

test("the interactive CLI visibly falls back to standard when thorough cleanup is unsupported", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-fallback-"));
  await fs.writeFile(path.join(fixture.codexHome, "state_6.sqlite"), "not a sqlite database");
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome, "--include-internals"],
    [
      { prompt: "session-steward> ", response: `delete ${fixtureSessionIds.parent}` },
      { prompt: "to confirm: ", response: "DELETE 2" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /Cleanup: Thorough/u);
  assert.match(output, /Using standard cleanup/u);
  assert.equal(
    queryRows(path.join(fixture.codexHome, "memories_1.sqlite"), "select count(*) as count from stage1_outputs")[0].count,
    2,
  );
});

test("the terminal CLI includes supporting sessions only when requested", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-supporting-"));
  const database = new DatabaseSync(path.join(fixture.codexHome, "state_5.sqlite"));
  database.prepare("update threads set title = ? where id = ?").run(
    "The following is the Codex agent history whose request action you are assessing: review",
    fixtureSessionIds.standalone,
  );
  database.close();
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });

  const hidden = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--json",
    "--include-internals",
  ], xdgConfigHome));
  const shown = JSON.parse(await runCli([
    "--codex-home", fixture.codexHome,
    "--json",
    "--include-internals",
    "--include-supporting",
  ], xdgConfigHome));

  assert.equal(hidden.some(({ id }) => id === fixtureSessionIds.standalone), false);
  assert.equal(shown.some(({ id }) => id === fixtureSessionIds.standalone), true);
});

test("the interactive CLI restores a retained recovery backup", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-restore-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  const provider = getProvider("codex");
  const store = await provider.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.standalone],
  });
  const plan = await provider.planSessionDeletion({
    recordIds: [fixtureSessionIds.standalone],
    store,
  });
  const cleanup = await provider.executeSessionDeletion({ plan, scope: "core", store });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome],
    [
      { prompt: "session-steward> ", response: "restore 1" },
      { prompt: 'to confirm: ', response: "RESTORE" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /Restored and verified/u);
  await fs.access(fixture.transcripts.standalone);
  await assert.rejects(fs.access(cleanup.backupDirectory), { code: "ENOENT" });
  assert.deepEqual(await provider.listSessionDeletionBackups({ codexHome: fixture.codexHome }), []);
});

test("the interactive CLI permanently deletes a recovery backup only after confirmation", async (context) => {
  const fixture = await createCodexHomeFixture();
  const xdgConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cli-delete-backup-"));
  context.after(async () => {
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(xdgConfigHome, { force: true, recursive: true }),
    ]);
  });
  const provider = getProvider("codex");
  const store = await provider.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.standalone],
  });
  const plan = await provider.planSessionDeletion({
    recordIds: [fixtureSessionIds.standalone],
    store,
  });
  const cleanup = await provider.executeSessionDeletion({ plan, scope: "core", store });

  const output = await runInteractiveCli(
    ["--codex-home", fixture.codexHome],
    [
      { prompt: "session-steward> ", response: "delete-backup 1" },
      { prompt: 'to confirm: ', response: "DELETE BACKUP" },
      { prompt: "Press Enter to continue...", response: "" },
      { prompt: "session-steward> ", response: "quit" },
    ],
    xdgConfigHome,
  );

  assert.match(output, /Deleted recovery backup/u);
  await assert.rejects(fs.access(cleanup.backupDirectory), { code: "ENOENT" });
  await assert.rejects(fs.access(fixture.transcripts.standalone), { code: "ENOENT" });
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
    "50",
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
      "0",
    ], xdgConfigHome),
    (error) => error.stderr === "Inactive days must be a whole number between 1 and 3650.\n",
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
