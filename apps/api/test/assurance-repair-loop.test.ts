import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssuranceRepairLoop } from '../src/modules/assurance/repair-loop.js';
import type { AssuranceDryRunResult } from '../src/modules/assurance/runner.js';

function dryRunResult(owner: 'gateway' | 'lse' | 'both' | 'none'): AssuranceDryRunResult {
  const failureCodes =
    owner === 'none'
      ? []
      : owner === 'lse'
        ? ['LSE_NO_WRITEBACK' as const]
        : owner === 'both'
          ? ['BOTH_EVIDENCE_SCHEMA_DRIFT' as const]
          : ['GW_NO_ALERT' as const];
  return {
    status: 'COMPLETED',
    stopReason: null,
    samples: [],
    artifactManifestPath: '/tmp/manifest.json',
    attributions: [{ owner, failureCodes }],
  };
}

test('runAssuranceRepairLoop repairs gateway failures, merges, and retests clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-loop-'));
  const commands: Array<{ cwd: string; command: string }> = [];
  const dryRuns = [dryRunResult('gateway'), dryRunResult('none')];

  const result = await runAssuranceRepairLoop({
    runId: 'run-1',
    maxCycles: 3,
    artifactRoot: dir,
    repairMode: 'legacy',
    gateway: {
      path: '/repo/gateway',
      mainBranch: 'main',
      repairCommand: 'make fix-gateway',
      verifyCommand: 'make test-gateway',
    },
    lse: {
      path: '/repo/lse',
      mainBranch: 'main',
      repairCommand: 'make fix-lse',
      verifyCommand: 'make test-lse',
    },
    dryRun: async () => dryRuns.shift() ?? dryRunResult('none'),
    shouldStop: async () => ({ stop: false, reason: null }),
    runCommand: async ({ cwd, command }) => {
      commands.push({ cwd, command });
      return { stdout: command === 'git status --porcelain' ? '' : '', stderr: '' };
    },
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.cycles.length, 1);
  assert.deepEqual(result.cycles[0]?.owners, ['gateway']);
  assert.deepEqual(
    commands.map((item) => [item.cwd, item.command]),
    [
      ['/repo/gateway', 'git status --porcelain'],
      ['/repo/gateway', 'git tag -f assurance-backup/run-1/gateway/1 HEAD'],
      ['/repo/gateway', 'git checkout -B assurance/run-1/gateway-cycle-1 main'],
      ['/repo/gateway', 'make fix-gateway'],
      ['/repo/gateway', 'make test-gateway'],
      ['/repo/gateway', 'git checkout main'],
      ['/repo/gateway', 'git merge --no-ff --no-edit assurance/run-1/gateway-cycle-1'],
    ],
  );

  const state = JSON.parse(await readFile(join(dir, 'run-1', 'loop-state.json'), 'utf8'));
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.cycles[0].owners[0], 'gateway');
});

test('runAssuranceRepairLoop pauses before repair when stop token appears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-loop-stop-'));
  const commands: string[] = [];
  const stopResults = [
    { stop: false, reason: null },
    { stop: true, reason: 'file:/tmp/STOP' },
  ];

  const result = await runAssuranceRepairLoop({
    runId: 'run-stop',
    maxCycles: 3,
    artifactRoot: dir,
    repairMode: 'legacy',
    gateway: {
      path: '/repo/gateway',
      mainBranch: 'main',
      repairCommand: 'make fix-gateway',
      verifyCommand: 'make test-gateway',
    },
    lse: {
      path: '/repo/lse',
      mainBranch: 'main',
      repairCommand: 'make fix-lse',
      verifyCommand: 'make test-lse',
    },
    dryRun: async () => dryRunResult('gateway'),
    shouldStop: async () => stopResults.shift() ?? { stop: false, reason: null },
    runCommand: async ({ command }) => {
      commands.push(command);
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'PAUSED');
  assert.equal(result.stopReason, 'file:/tmp/STOP');
  assert.deepEqual(commands, []);
});

test('runAssuranceRepairLoop repairs both repos for shared contract drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-loop-both-'));
  const commands: Array<{ cwd: string; command: string }> = [];
  const dryRuns = [dryRunResult('both'), dryRunResult('none')];

  const result = await runAssuranceRepairLoop({
    runId: 'run both',
    maxCycles: 2,
    artifactRoot: dir,
    repairMode: 'legacy',
    gateway: {
      path: '/repo/gateway',
      mainBranch: 'main',
      repairCommand: 'make fix-gateway',
      verifyCommand: 'make test-gateway',
    },
    lse: {
      path: '/repo/lse',
      mainBranch: 'main',
      repairCommand: 'make fix-lse',
      verifyCommand: 'make test-lse',
    },
    dryRun: async () => dryRuns.shift() ?? dryRunResult('none'),
    shouldStop: async () => ({ stop: false, reason: null }),
    runCommand: async ({ cwd, command }) => {
      commands.push({ cwd, command });
      return { stdout: command === 'git status --porcelain' ? '' : '', stderr: '' };
    },
  });

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.cycles[0]?.owners, ['gateway', 'lse']);
  assert(
    commands.some((item) => item.cwd === '/repo/gateway' && item.command === 'make fix-gateway'),
  );
  assert(commands.some((item) => item.cwd === '/repo/lse' && item.command === 'make fix-lse'));
  assert(
    commands.some((item) => item.command === 'git checkout -B assurance/run-both/lse-cycle-1 main'),
  );
});

test('runAssuranceRepairLoop fails fast and records repair events when a repair command times out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-loop-timeout-'));
  const commands: Array<{ command: string; timeoutMs?: number }> = [];

  const result = await runAssuranceRepairLoop({
    runId: 'run-timeout',
    maxCycles: 2,
    artifactRoot: dir,
    repairMode: 'legacy',
    gateway: {
      path: '/repo/gateway',
      mainBranch: 'main',
      repairCommand: 'make fix-gateway',
      verifyCommand: 'make test-gateway',
    },
    lse: {
      path: '/repo/lse',
      mainBranch: 'main',
      repairCommand: 'codex exec fix-lse',
      verifyCommand: 'make test-lse',
      repairTimeoutMs: 1234,
    },
    dryRun: async () => dryRunResult('lse'),
    shouldStop: async () => ({ stop: false, reason: null }),
    runCommand: async (input) => {
      commands.push({ command: input.command, timeoutMs: input.timeoutMs });
      if (input.command === 'codex exec fix-lse') {
        throw new Error('command timed out after 1234ms');
      }
      return { stdout: input.command === 'git status --porcelain' ? '' : '', stderr: '' };
    },
  });

  assert.equal(result.status, 'FAILED');
  assert.match(result.stopReason ?? '', /lse repair failed/);
  assert.equal(commands.find((item) => item.command === 'codex exec fix-lse')?.timeoutMs, 1234);

  const state = JSON.parse(await readFile(join(dir, 'run-timeout', 'loop-state.json'), 'utf8'));
  assert.equal(state.status, 'FAILED');
  assert.match(state.stop_reason, /command timed out/);

  const events = (await readFile(join(dir, 'run-timeout', 'repair-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => [event.event, event.owner, event.stage]),
    [
      ['started', 'lse', 'git_status'],
      ['completed', 'lse', 'git_status'],
      ['started', 'lse', 'backup_tag'],
      ['completed', 'lse', 'backup_tag'],
      ['started', 'lse', 'checkout_branch'],
      ['completed', 'lse', 'checkout_branch'],
      ['started', 'lse', 'repair'],
      ['failed', 'lse', 'repair'],
    ],
  );
});

test('runAssuranceRepairLoop dispatches defects to factory instead of self-repairing (mode=factory)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-dispatch-'));
  const dispatched: Array<{ runDir: string; runId: string; dryRun: boolean }> = [];
  const commands: string[] = [];
  const result = await runAssuranceRepairLoop({
    runId: 'run-dispatch',
    maxCycles: 3,
    artifactRoot: dir,
    repairMode: 'factory',
    gateway: { path: '/repo/gateway', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    lse: { path: '/repo/lse', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    dryRun: async () => dryRunResult('gateway'),
    shouldStop: async () => ({ stop: false, reason: null }),
    runCommand: async ({ command }) => {
      commands.push(command);
      return { stdout: '', stderr: '' };
    },
    dispatchToFactory: async (input) => {
      dispatched.push(input);
    },
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.runId, 'run-dispatch');
  assert.equal(dispatched[0]?.dryRun, false);
  assert.ok(dispatched[0]?.runDir.endsWith('run-dispatch'));
  assert.deepEqual(result.cycles[0]?.owners, ['gateway']);
  // 关键：走工厂分支时绝不在环内跑 repairRepo（不应有任何 git/repair 命令）
  assert.equal(commands.length, 0);
});

test('runAssuranceRepairLoop dry mode dispatches with dryRun=true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-drydispatch-'));
  const dispatched: boolean[] = [];
  const result = await runAssuranceRepairLoop({
    runId: 'run-dry',
    maxCycles: 3,
    artifactRoot: dir,
    repairMode: 'dry',
    gateway: { path: '/repo/gateway', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    lse: { path: '/repo/lse', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    dryRun: async () => dryRunResult('both'),
    shouldStop: async () => ({ stop: false, reason: null }),
    dispatchToFactory: async (input) => {
      dispatched.push(input.dryRun);
    },
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(dispatched[0], true);
});

test('runAssuranceRepairLoop factory dispatch failure stays non-fatal (COMPLETED, no retry storm)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lse-assurance-faildispatch-'));
  const result = await runAssuranceRepairLoop({
    runId: 'run-failsubmit',
    maxCycles: 3,
    artifactRoot: dir,
    repairMode: 'factory',
    gateway: { path: '/repo/gateway', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    lse: { path: '/repo/lse', mainBranch: 'main', repairCommand: '', verifyCommand: '' },
    dryRun: async () => dryRunResult('gateway'),
    shouldStop: async () => ({ stop: false, reason: null }),
    dispatchToFactory: async () => {
      throw new Error('submitter boom');
    },
  });
  assert.equal(result.status, 'COMPLETED');
});
