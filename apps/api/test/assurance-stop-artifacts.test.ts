import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldStopAssuranceRun } from '../src/modules/assurance/stop-token.js';
import { writeAssuranceArtifactManifest } from '../src/modules/assurance/artifacts.js';

test('shouldStopAssuranceRun honors env kill switch', async () => {
  const previous = process.env.ASSURANCE_STOP;
  process.env.ASSURANCE_STOP = '1';
  try {
    const result = await shouldStopAssuranceRun({});
    assert.equal(result.stop, true);
    assert.equal(result.reason, 'env:ASSURANCE_STOP');
  } finally {
    if (previous === undefined) delete process.env.ASSURANCE_STOP;
    else process.env.ASSURANCE_STOP = previous;
  }
});

test('shouldStopAssuranceRun honors STOP file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-stop-'));
  try {
    const stopFile = join(dir, 'STOP');
    await writeFile(stopFile, 'pause for inspection', 'utf8');
    const result = await shouldStopAssuranceRun({ stopFile });
    assert.equal(result.stop, true);
    assert.equal(result.reason, `file:${stopFile}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeAssuranceArtifactManifest writes run checkpoint summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-artifact-'));
  try {
    const path = await writeAssuranceArtifactManifest({
      rootDir: dir,
      runId: 'run-1',
      status: 'PAUSED',
      gatewayRef: 'gw-sha',
      lseRef: 'lse-sha',
      sampleCount: 10,
      failureCount: 2,
      notes: ['stopped before merge'],
    });
    const raw = await readFile(path, 'utf8');
    const manifest = JSON.parse(raw);
    assert.equal(manifest.run_id, 'run-1');
    assert.equal(manifest.status, 'PAUSED');
    assert.equal(manifest.gateway_ref, 'gw-sha');
    assert.equal(manifest.sample_count, 10);
    assert.equal(manifest.failure_count, 2);
    assert.deepEqual(manifest.notes, ['stopped before merge']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
