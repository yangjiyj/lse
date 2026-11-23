import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { shouldStopAssuranceRun, type StopTokenResult } from './stop-token.js';
import type { AssuranceDryRunResult } from './runner.js';
import type { AssuranceAttribution } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REPAIR_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const FACTORY_SUBMITTER =
  process.env.ASSURANCE_FACTORY_SUBMITTER ??
  '/opt/ai-dev-factory/scripts/submit-assurance-to-factory.sh';

export interface AssuranceRepoConfig {
  path: string;
  mainBranch: string;
  repairCommand: string;
  verifyCommand: string;
  pushCommand?: string;
  commandTimeoutMs?: number;
  repairTimeoutMs?: number;
  verifyTimeoutMs?: number;
  pushTimeoutMs?: number;
}

export interface AssuranceCommandInput {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface AssuranceCommandResult {
  stdout: string;
  stderr: string;
}

export interface AssuranceRepairLoopOptions {
  runId: string;
  maxCycles: number;
  artifactRoot: string;
  stopFile?: string;
  gateway: AssuranceRepoConfig;
  lse: AssuranceRepoConfig;
  dryRun: () => Promise<AssuranceDryRunResult>;
  shouldStop?: () => Promise<StopTokenResult>;
  runCommand?: (input: AssuranceCommandInput) => Promise<AssuranceCommandResult>;
  /**
   * 'factory'（默认）= 把缺陷投递到研发工厂门禁（止于 ready，不在环内自改代码）；
   * 'dry' = 只打印将投递的任务、不落库（上线前验证管道）；
   * 'legacy' = 旧的环内 repairRepo 自修（仅 CI/逃生；生产 repairCommand 为空会失败）。
   */
  repairMode?: 'factory' | 'dry' | 'legacy';
  /** 测试注入点：覆盖默认的「spawn 投递器」实现。 */
  dispatchToFactory?: (input: FactoryDispatchInput) => Promise<void>;
}

export interface FactoryDispatchInput {
  runDir: string;
  runId: string;
  dryRun: boolean;
}

export interface AssuranceRepairCycle {
  cycle: number;
  owners: Array<'gateway' | 'lse'>;
  branchNames: Record<string, string>;
}

export interface AssuranceRepairLoopResult {
  status: 'COMPLETED' | 'PAUSED' | 'FAILED';
  stopReason: string | null;
  cycles: AssuranceRepairCycle[];
  finalDryRun: AssuranceDryRunResult | null;
}

type RepairStage =
  | 'git_status'
  | 'backup_tag'
  | 'checkout_branch'
  | 'repair'
  | 'verify'
  | 'checkout_main'
  | 'merge'
  | 'push';

export async function runAssuranceRepairLoop(
  options: AssuranceRepairLoopOptions,
): Promise<AssuranceRepairLoopResult> {
  const runCommand = options.runCommand ?? runShellCommand;
  const stop = options.shouldStop ?? (() => shouldStopAssuranceRun({ stopFile: options.stopFile }));
  const repairMode = resolveRepairMode(options.repairMode);
  const dispatchToFactory = options.dispatchToFactory ?? defaultDispatchToFactory;
  const cycles: AssuranceRepairCycle[] = [];
  const maxCycles = Math.max(1, options.maxCycles);

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const beforeDryRunStop = await stop();
    if (beforeDryRunStop.stop) {
      return writeLoopState(options, {
        status: 'PAUSED',
        stopReason: beforeDryRunStop.reason,
        cycles,
        finalDryRun: null,
      });
    }

    const dryRun = await options.dryRun();
    if (dryRun.status === 'PAUSED') {
      return writeLoopState(options, {
        status: 'PAUSED',
        stopReason: dryRun.stopReason,
        cycles,
        finalDryRun: dryRun,
      });
    }

    const owners = ownersToRepair(dryRun.attributions);
    if (owners.length === 0) {
      return writeLoopState(options, {
        status: 'COMPLETED',
        stopReason: null,
        cycles,
        finalDryRun: dryRun,
      });
    }

    if (repairMode !== 'legacy') {
      // 改走工厂门禁：把缺陷投递成工厂任务（止于 ready），绝不在环内自改代码。
      // 投递失败也不能把整轮判 FAILED（否则 wrapper 会无脑重试风暴）。
      const cycleState: AssuranceRepairCycle = { cycle, owners, branchNames: {} };
      cycles.push(cycleState);
      try {
        await dispatchToFactory({
          runDir: join(options.artifactRoot, options.runId),
          runId: options.runId,
          dryRun: repairMode !== 'factory',
        });
        return writeLoopState(options, {
          status: 'COMPLETED',
          stopReason: `dispatched ${owners.length} owner(s) to factory (mode=${repairMode})`,
          cycles,
          finalDryRun: dryRun,
        });
      } catch (error) {
        return writeLoopState(options, {
          status: 'COMPLETED',
          stopReason: `factory dispatch error (non-fatal): ${errorMessage(error)}`,
          cycles,
          finalDryRun: dryRun,
        });
      }
    }

    const beforeRepairStop = await stop();
    if (beforeRepairStop.stop) {
      return writeLoopState(options, {
        status: 'PAUSED',
        stopReason: beforeRepairStop.reason,
        cycles,
        finalDryRun: dryRun,
      });
    }

    const cycleState: AssuranceRepairCycle = { cycle, owners, branchNames: {} };
    cycles.push(cycleState);
    for (const owner of owners) {
      const repo = owner === 'gateway' ? options.gateway : options.lse;
      try {
        cycleState.branchNames[owner] = await repairRepo({
          owner,
          repo,
          cycle,
          runId: options.runId,
          artifactRoot: options.artifactRoot,
          runCommand,
        });
      } catch (error) {
        return writeLoopState(options, {
          status: 'FAILED',
          stopReason: `${owner} repair failed: ${errorMessage(error)}`,
          cycles,
          finalDryRun: dryRun,
        });
      }
    }
  }

  const finalDryRun = await options.dryRun();
  return writeLoopState(options, {
    status: 'FAILED',
    stopReason: `max cycles reached: ${maxCycles}`,
    cycles,
    finalDryRun,
  });
}

function resolveRepairMode(explicit?: 'factory' | 'dry' | 'legacy'): 'factory' | 'dry' | 'legacy' {
  if (explicit) return explicit;
  const env = process.env.ASSURANCE_REPAIR_MODE;
  return env === 'factory' || env === 'legacy' || env === 'dry' ? env : 'dry';
}

async function defaultDispatchToFactory(input: FactoryDispatchInput): Promise<void> {
  const args = [FACTORY_SUBMITTER, '--run-dir', input.runDir, '--run-id', input.runId];
  if (input.dryRun) args.push('--dry-run');
  await execFileAsync('bash', args, { timeout: 120_000 });
}

function ownersToRepair(attributions: AssuranceAttribution[]): Array<'gateway' | 'lse'> {
  const owners = new Set<'gateway' | 'lse'>();
  for (const attribution of attributions) {
    if (attribution.failureCodes.length === 0 || attribution.owner === 'none') continue;
    if (attribution.owner === 'gateway') owners.add('gateway');
    if (attribution.owner === 'lse') owners.add('lse');
    if (attribution.owner === 'both') {
      owners.add('gateway');
      owners.add('lse');
    }
  }
  const order: Array<'gateway' | 'lse'> = ['gateway', 'lse'];
  return order.filter((owner) => owners.has(owner));
}

async function repairRepo(input: {
  owner: 'gateway' | 'lse';
  repo: AssuranceRepoConfig;
  cycle: number;
  runId: string;
  artifactRoot: string;
  runCommand: (input: AssuranceCommandInput) => Promise<AssuranceCommandResult>;
}): Promise<string> {
  if (!input.repo.repairCommand.trim()) {
    throw new Error(`${input.owner} repair command is required`);
  }
  if (!input.repo.verifyCommand.trim()) {
    throw new Error(`${input.owner} verify command is required`);
  }

  const safeRun = slug(input.runId);
  const branch = `assurance/${safeRun}/${input.owner}-cycle-${input.cycle}`;
  const env = {
    ASSURANCE_OWNER: input.owner,
    ASSURANCE_RUN_ID: input.runId,
    ASSURANCE_CYCLE: String(input.cycle),
  };
  const cwd = input.repo.path;
  const commandTimeoutMs = timeoutMs(input.repo.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  const repairTimeoutMs = timeoutMs(input.repo.repairTimeoutMs, DEFAULT_REPAIR_TIMEOUT_MS);
  const verifyTimeoutMs = timeoutMs(input.repo.verifyTimeoutMs, DEFAULT_VERIFY_TIMEOUT_MS);
  const pushTimeoutMs = timeoutMs(input.repo.pushTimeoutMs, DEFAULT_PUSH_TIMEOUT_MS);
  const runStage = (stage: RepairStage, command: string, timeout: number | undefined) =>
    runRepairStage({
      artifactRoot: input.artifactRoot,
      runId: input.runId,
      owner: input.owner,
      cycle: input.cycle,
      stage,
      cwd,
      command,
      env,
      timeoutMs: timeout,
      runCommand: input.runCommand,
    });

  const dirty = await runStage('git_status', 'git status --porcelain', commandTimeoutMs);
  if (dirty.stdout.trim()) {
    throw new Error(`${input.owner} repo is dirty; refuse to auto-repair: ${cwd}`);
  }
  await runStage(
    'backup_tag',
    `git tag -f assurance-backup/${safeRun}/${input.owner}/${input.cycle} HEAD`,
    commandTimeoutMs,
  );
  await runStage(
    'checkout_branch',
    `git checkout -B ${branch} ${input.repo.mainBranch}`,
    commandTimeoutMs,
  );
  await runStage('repair', input.repo.repairCommand, repairTimeoutMs);
  await runStage('verify', input.repo.verifyCommand, verifyTimeoutMs);
  await runStage('checkout_main', `git checkout ${input.repo.mainBranch}`, commandTimeoutMs);
  await runStage('merge', `git merge --no-ff --no-edit ${branch}`, commandTimeoutMs);
  if (input.repo.pushCommand?.trim()) {
    await runStage('push', input.repo.pushCommand, pushTimeoutMs);
  }
  return branch;
}

async function runRepairStage(input: {
  artifactRoot: string;
  runId: string;
  owner: 'gateway' | 'lse';
  cycle: number;
  stage: RepairStage;
  cwd: string;
  command: string;
  env: Record<string, string>;
  timeoutMs: number | undefined;
  runCommand: (input: AssuranceCommandInput) => Promise<AssuranceCommandResult>;
}): Promise<AssuranceCommandResult> {
  const startedAt = Date.now();
  await appendRepairEvent(input.artifactRoot, input.runId, {
    event: 'started',
    owner: input.owner,
    cycle: input.cycle,
    stage: input.stage,
    cwd: input.cwd,
    command: eventCommand(input.command),
    timeout_ms: input.timeoutMs ?? null,
    written_at: new Date(startedAt).toISOString(),
  });
  try {
    const result = await input.runCommand({
      cwd: input.cwd,
      command: input.command,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
    await appendRepairEvent(input.artifactRoot, input.runId, {
      event: 'completed',
      owner: input.owner,
      cycle: input.cycle,
      stage: input.stage,
      duration_ms: Date.now() - startedAt,
      stdout_bytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
      stderr_bytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
      written_at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    await appendRepairEvent(input.artifactRoot, input.runId, {
      event: 'failed',
      owner: input.owner,
      cycle: input.cycle,
      stage: input.stage,
      duration_ms: Date.now() - startedAt,
      error: errorMessage(error),
      written_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function runShellCommand(input: AssuranceCommandInput): Promise<AssuranceCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      maxBuffer: 1024 * 1024 * 20,
      timeout: input.timeoutMs ?? 0,
      killSignal: 'SIGTERM',
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    throw new Error(commandErrorMessage(error, input.timeoutMs));
  }
}

async function writeLoopState(
  options: AssuranceRepairLoopOptions,
  result: AssuranceRepairLoopResult,
): Promise<AssuranceRepairLoopResult> {
  const runDir = join(options.artifactRoot, options.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'loop-state.json'),
    `${JSON.stringify(
      {
        schema_version: 'gateway-lse-assurance-loop/v1',
        run_id: options.runId,
        status: result.status,
        stop_reason: result.stopReason,
        cycles: result.cycles,
        final_status: result.finalDryRun?.status ?? null,
        final_failure_count:
          result.finalDryRun?.attributions.filter((item) => item.failureCodes.length > 0).length ??
          null,
        written_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return result;
}

async function appendRepairEvent(
  artifactRoot: string,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const runDir = join(artifactRoot, runId);
  await mkdir(runDir, { recursive: true });
  await appendFile(join(runDir, 'repair-events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

function timeoutMs(value: number | undefined, fallback: number): number | undefined {
  if (value === 0) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function commandErrorMessage(error: unknown, configuredTimeoutMs: number | undefined): string {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const signal = typeof record.signal === 'string' ? record.signal : '';
    const killed = record.killed === true;
    const timedOut = killed && configuredTimeoutMs !== undefined && configuredTimeoutMs > 0;
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
    const message = errorMessage(error);
    if (timedOut)
      return `command timed out after ${configuredTimeoutMs}ms${stderr ? `: ${stderr}` : ''}`;
    if (signal) return `command failed with signal ${signal}: ${stderr || message}`;
    return stderr || message;
  }
  return errorMessage(error);
}

function eventCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'run'
  );
}
