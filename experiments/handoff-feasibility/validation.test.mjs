import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { exportArchive, digest, CHUNK_BYTES } from './prototype.mjs';
import { getProvider } from '../../lib/providers/index.mjs';
import { createCodexHomeFixture, fixtureSessionIds } from '../../test/fixtures/codex-home.mjs';
import { createClaudeHomeFixture } from '../../test/fixtures/claude-home.mjs';

const base = new URL('./.artifacts/', import.meta.url);

for (const name of ['short-codex', 'long-codex-3-months', 'long-claude-6-months', 'old-claude-9-months']) {
  test(`${name}: early, middle and recent facts survive; output remains bounded and project-specific`, async () => {
    const directory = new URL(`${name}/`, base);
    const manifest = JSON.parse(await fs.readFile(new URL('indexed/manifest.json', directory), 'utf8'));
    const hash = await digest(new URL('source.jsonl', directory));
    const recorded = JSON.parse(await fs.readFile(new URL('preparation-results.json', base), 'utf8')).find(item => item.name === name);
    assert.equal(hash, recorded.sourceHash);
    const required = new Set(['Project Aurora', 'X-Legacy-Nonce', 'X-Aurora-Request', '7 to 14', 'legacy/importer.mjs', 'Do not publish', 'test/aurora/retry-boundary.test.mjs', 'FAILED', 'feature/aurora-retries']);
    for (const chunk of manifest.chunks) {
      const bytes = await fs.readFile(new URL(`indexed/${chunk.file}`, directory));
      assert.ok(bytes.length <= CHUNK_BYTES);
      const text = bytes.toString();
      assert.ok(!text.includes('X-Borealis'));
      assert.ok(!text.includes('\uFFFD'), 'Unicode must not be split into replacement characters');
      for (const fact of required) if (text.includes(fact)) required.delete(fact);
    }
    assert.deepEqual([...required], []);
    const recent = await fs.readFile(new URL('recent-only/START.md', directory), 'utf8');
    assert.ok(!recent.includes('X-Aurora-Request'), 'a recent-only export demonstrably drops earlier corrections');
    assert.ok(!recent.includes('legacy/importer.mjs'));
    assert.ok(!recent.includes('retry-boundary.test.mjs'));
  });
}

test('malformed and unknown records are reported rather than claiming complete fidelity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('old-claude-9-months/indexed/manifest.json', base), 'utf8'));
  assert.equal(manifest.invalid, 1);
  assert.deepEqual(manifest.unsupported, { 'future-message': 1 });
  assert.match(await fs.readFile(new URL('old-claude-9-months/indexed/START.md', base), 'utf8'), /Do not claim complete coverage/);
});

test('oversized input is bounded and explicitly reported', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-handoff-oversized-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.jsonl');
  await fs.writeFile(source, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2048) } }) + '\n');
  const result = await exportArchive({ provider: 'claude-code', source, destination: path.join(root, 'export'), workspace: root, sessionId: 'large-line', maxLineBytes: 1024 });
  assert.equal(result.oversized, 1);
  assert.equal(result.messages, 0);
  assert.match(await fs.readFile(path.join(root, 'export/history/part-00001.md'), 'utf8'), /NOT exported/);
});

test('missing source fails without creating a usable handoff', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-handoff-missing-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'export');
  await assert.rejects(exportArchive({ provider: 'codex', source: path.join(root, 'absent'), destination, workspace: root, sessionId: 'absent' }), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(destination, 'START.md')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(destination, 'FAILED.txt'), 'utf8'), /do not launch/);
});

test('destination collisions cannot overwrite an existing handoff', async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-handoff-collision-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'export'); await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'KEEP'), 'existing data');
  await assert.rejects(exportArchive({ provider: 'codex', source: '/absent', destination, workspace: root, sessionId: 'same' }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(destination, 'KEEP'), 'utf8'), 'existing data');
});

for (const layout of ['state_5', 'state_6']) {
  test(`existing Codex ${layout} fixture exports without changing the source`, async context => {
    const fixture = await createCodexHomeFixture({ layout, includeEventTranscript: true });
    context.after(() => fs.rm(fixture.codexHome, { recursive: true, force: true }));
    const source = fixture.transcripts.parent; const before = await digest(source);
    const existing = await getProvider('codex').readSessionEvents({ codexHome: fixture.codexHome, id: fixtureSessionIds.parent, mode: 'recent', limit: 1000 });
    assert.ok(existing.events.length > 0);
    const result = await exportArchive({ provider: 'codex', source, destination: path.join(fixture.codexHome, 'research-export'), workspace: fixture.workspace, sessionId: fixtureSessionIds.parent });
    assert.ok(result.messages > 0); assert.equal(await digest(source), before);
    // Unknown fixture records must stay visible as a fidelity limitation.
    assert.ok(Object.keys(result.unsupported).length > 0 || result.invalid > 0);
  });
}

for (const layout of ['current', 'alternate']) {
  test(`existing Claude ${layout} fixture exports without changing the source`, async context => {
    const fixture = await createClaudeHomeFixture({ layout, includeEventTranscript: true });
    context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const source = fixture.cliTranscript; const before = await digest(source);
    const existing = await getProvider('claude-code').readSessionEvents({ claudeHome: fixture.claudeHome, desktopDataHome: fixture.desktopDataHome, id: fixture.cliId, mode: 'recent', limit: 1000 });
    assert.ok(existing.events.length > 0);
    const result = await exportArchive({ provider: 'claude-code', source, destination: path.join(fixture.root, 'research-export'), workspace: '/workspace/demo', sessionId: fixture.cliId });
    assert.ok(result.messages > 0); assert.equal(await digest(source), before);
  });
}

for (const version of ['2.1.325', '2.1.330']) {
  test(`captured Claude ${version} fixture retains the actual request and response`, async context => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-handoff-current-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = new URL(`../../test/fixtures/claude-${version}.jsonl`, import.meta.url).pathname;
    const result = await exportArchive({ provider: 'claude-code', source, destination: path.join(root, 'export'), workspace: '/workspace/compatibility', sessionId: 'fixture' });
    const archive = await fs.readFile(path.join(root, 'export', result.chunks[0].file), 'utf8');
    assert.match(archive, /Compatibility fixture request/);
    assert.match(archive, /Compatibility fixture response/);
  });
}

test('current timeline API returns only the newest 1000 of 25000 messages', async context => {
  const fixture = await createCodexHomeFixture();
  context.after(() => fs.rm(fixture.codexHome, { recursive: true, force: true }));
  await fs.copyFile(new URL('long-codex-3-months/source.jsonl', base), fixture.transcripts.parent);
  const result = await getProvider('codex').readSessionEvents({ codexHome: fixture.codexHome, id: fixtureSessionIds.parent, mode: 'recent', limit: 1000 });
  assert.equal(result.events.length, 1000);
  assert.ok(!JSON.stringify(result.events).includes('X-Aurora-Request'));
});

test('a selected session among 5000 sessions across 25 projects exports without including its neighbours', async context => {
  const fixture = await createClaudeHomeFixture({ extraSessions: 5000 });
  context.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const started = performance.now();
  const selected = await getProvider('claude-code').listSessions({ ...fixture, workspace: '/workspace/project-17', page: 1, pageSize: 25, sort: 'updated' });
  const discoveryMs = performance.now() - started;
  assert.equal(selected.total, 200);
  assert.equal(selected.records.length, 25);
  assert.ok(selected.records.every(record => record.cwd === '/workspace/project-17'));
  const chosen = selected.records[0];
  const result = await exportArchive({ provider: 'claude-code', source: chosen.rolloutPath, destination: path.join(fixture.root, 'selected-export'), workspace: chosen.cwd, sessionId: chosen.id });
  assert.equal(result.messages, 1);
  assert.equal(result.sessionId, chosen.id);
  const exported = await fs.readFile(path.join(fixture.root, 'selected-export', result.chunks[0].file), 'utf8');
  const selectedText = chosen.displayName;
  assert.ok(exported.includes(selectedText));
  for (const other of selected.records.slice(1)) assert.ok(!exported.includes(`${other.displayName}\n`));
  await fs.writeFile(new URL('multi-project-results.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), sessions: 5003, generatedProjects: 25, selectedWorkspace: chosen.cwd, matchingSessions: selected.total, pageSize: selected.records.length, discoveryMs: +discoveryMs.toFixed(2), exportMs: result.durationMs, exportedMessages: result.messages }, null, 2));
});
