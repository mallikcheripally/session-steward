import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportArchive } from './prototype.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '.artifacts/scale');
const execute = promisify(execFile);
if (process.argv[2] === '--measure') {
  global.gc?.();
  const baselineRssMiB = process.resourceUsage().maxRSS / 1024;
  const result = await exportArchive({ provider: 'claude-code', source: process.argv[3], destination: process.argv[4], workspace: '/synthetic/scale-project', sessionId: 'synthetic-scale' });
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({ inputBytes: result.snapshot.snapshotBytes, durationMs: result.durationMs, records: result.records, chunks: result.chunks.length, baselineRssMiB, peakRssMiB, increaseRssMiB: peakRssMiB - baselineRssMiB, invalid: result.invalid, oversized: result.oversized }));
} else {
  await fs.mkdir(root, { recursive: true });
  const results = [];
  for (const mib of [32, 256]) {
    const source = path.join(root, `${mib}.jsonl`);
    const line = JSON.stringify({ type: 'assistant', message: { content: 'Synthetic command output with Unicode 東京 and ordinary text. '.repeat(128) } }) + '\n';
    const buffer = Buffer.from(line.repeat(64)); const handle = await fs.open(source, 'w');
    for (let bytes = 0; bytes < mib * 1024 * 1024; bytes += buffer.length) await handle.write(buffer);
    await handle.close();
    const destination = path.join(root, `${mib}-export`);
    await fs.rm(destination, { recursive: true, force: true });
    const { stdout } = await execute(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure', source, destination], { maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout); results.push(result); console.log(JSON.stringify(result));
    assert.equal(result.invalid, 0); assert.equal(result.oversized, 0);
    assert.ok(result.increaseRssMiB < 96, 'prototype export must not buffer its complete input');
  }
  assert.ok(results[1].peakRssMiB - results[0].peakRssMiB < 64, '8x input must not produce proportional resident memory growth');
  await fs.writeFile(path.join(here, 'scale-results.json'), JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, results }, null, 2));
}
