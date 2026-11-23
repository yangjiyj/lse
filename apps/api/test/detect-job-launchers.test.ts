import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import {
  DETECT_JOB_ITEM_KINDS,
  DETECT_JOB_ITEM_META,
  DETECT_TASK_STATUSES,
  type DetectJobItemKind,
} from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { AppError } from '../src/lib/errors.js';
import { loadCurrentUser, type CurrentUser } from '../src/lib/rbac.js';
import { runInTenant } from '../src/lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../src/lib/tenant-models.js';
import { readScopeConfig, saveScopeConfig } from '../src/modules/asset-discovery/service.js';
import { startAssetDiscoveryRun } from '../src/modules/asset-discovery/launch.js';
import { DEFAULT_LAUNCHERS, type LaunchContext } from '../src/modules/detect-jobs/launchers.js';
import { parseDetectJobItemParams } from '../src/modules/detect-jobs/item-params.js';
import { applyRecordAction, supportedActions } from '../src/modules/detect-jobs/record-actions.js';
import { sampleReport } from './fleet-admin-fixtures.js';
import { maliciousPickle } from './helpers/model-file-fixtures.js';

// B-3 子任务启动函数与记录操作（2.4.9、2.4.2）：各类检测抽成可复用的启动函数，统一暂停、恢复、停止。

const P = '__p2bb_launch_';
const PASSWORD = ['Launch', 'Job', '12345'].join('@');

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let admin!: CurrentUser;
let auditor!: CurrentUser;
let base = '';
let storageDir = '';
let targetId = '';
let questionSetId = '';
let savedScope: Awaited<ReturnType<typeof readScopeConfig>> | null = null;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const inPlatform = <T>(fn: () => Promise<T>) => runInTenant(PLATFORM_TENANT_ID, fn);
const ctx = (user: CurrentUser, title = `${P}子任务`): LaunchContext & { title: string } => ({
  user,
  ip: '127.0.0.1',
  userAgent: 'node-test',
  source: 'detect_job',
  title,
});

function isStatus(status: number, code?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.statusCode, status, err.message);
    if (code) assert.equal(err.code, code);
    return true;
  };
}

async function cleanup(): Promise<void> {
  const tasks = await prismaUnscoped.evalTask.findMany({
    where: { OR: [{ name: { startsWith: P } }, { modelTarget: { name: { startsWith: P } } }] },
    select: { id: true },
  });
  const taskIds = tasks.map((t) => t.id);
  await prismaUnscoped.auditLog.deleteMany({ where: { targetId: { in: taskIds } } });
  await prismaUnscoped.evalTask.deleteMany({ where: { id: { in: taskIds } } });
  await prismaUnscoped.question.deleteMany({ where: { questionSet: { name: { startsWith: P } } } });
  await prismaUnscoped.questionSet.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.modelFileScan.deleteMany({ where: { path: { contains: 'p2bb-launch-' } } });
  await prismaUnscoped.corpusScan.deleteMany({ where: { fileName: { startsWith: P } } });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({
    where: { createdByName: 'admin', targets: { has: '127.0.0.1' } },
  });
  await prismaUnscoped.fleetProbeReport.deleteMany({
    where: { endpoint: { hostname: { startsWith: P } } },
  });
  await prismaUnscoped.fleetEndpoint.deleteMany({ where: { hostname: { startsWith: P } } });
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: P } } });
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function uploadCorpus(name: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans?fileName=${encodeURIComponent(P + name)}&format=auto`,
    headers: { ...bearer(adminToken), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body, 'utf8'),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

before(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'p2bb-launch-corpus-'));
  process.env.CORPUS_STORAGE_DIR = storageDir;
  process.env.FLEET_AGENT_ENABLED = 'true';
  app = await buildApp();
  await app.ready();
  await cleanup();
  adminToken = await login('admin', ['Admin', '@', '12345'].join(''));
  const adminRow = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
  admin = (await loadCurrentUser(adminRow.id))!;
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'auditor' } });
  const au = await prisma.user.create({
    data: {
      username: `${P}au`,
      passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
      displayName: 'au',
      roles: { create: { roleId: role.id } },
    },
  });
  auditor = (await loadCurrentUser(au.id))!;

  targetId = (
    await prisma.modelTarget.create({
      data: {
        name: `${P}target`,
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'dummy-launch-key', // pragma: allowlist secret
        model: 'fake-model',
      },
    })
  ).id;
  const set = await prisma.questionSet.create({
    data: {
      name: `${P}样本库`,
      questions: { create: [{ content: '题目一' }, { content: '题目二' }] },
    },
  });
  questionSetId = set.id;

  base = await mkdtemp(join(tmpdir(), 'p2bb-launch-'));
  await mkdir(join(base, 'models'), { recursive: true });
  await writeFile(join(base, 'models', 'evil.pkl'), maliciousPickle());
  const cfg = await app.inject({
    method: 'PUT',
    url: '/api/model-files/config',
    headers: bearer(adminToken),
    payload: {
      roots: [join(base, 'models')],
      pickleMaxBytes: 1 << 20,
      totalMaxBytes: 1 << 24,
      maxFiles: 100,
    },
  });
  assert.equal(cfg.statusCode, 200, cfg.body);

  savedScope = await readScopeConfig();
  await saveScopeConfig({ entries: ['127.0.0.1'], ports: [9], maxHostsPerRun: 16 }, admin.id);
});

after(async () => {
  await cleanup();
  await prisma.systemSetting.deleteMany({ where: { key: 'model_file_scan.config' } });
  if (savedScope) await saveScopeConfig(savedScope, admin.id);
  await app.close();
  await rm(base, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.CORPUS_STORAGE_DIR;
});

// ---- 参数 ----

const VALID_PARAMS: Record<DetectJobItemKind, unknown> = {
  eval_task: { modelTargetId: randomUUID(), questionSetIds: [randomUUID()] },
  model_file_scan: { source: 'directory', path: '/models/a' },
  corpus_scan: { sourceScanId: randomUUID(), ruleSetId: null, judgeReview: false },
  asset_discovery: { targets: ['10.0.0.1'], ports: [11434], confirm: true },
  fleet_posture: { endpointId: randomUUID(), items: ['permissions'] },
};

test('子任务参数：每类合法样例通过；资产测绘没确认授权、模型文件来源不认识都是 400', () => {
  for (const kind of DETECT_JOB_ITEM_KINDS) {
    assert.doesNotThrow(() => parseDetectJobItemParams(kind, VALID_PARAMS[kind], 0), kind);
  }
  assert.throws(
    () => parseDetectJobItemParams('asset_discovery', { targets: ['10.0.0.1'], ports: [80] }, 1),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /第 2 项/);
      return true;
    },
  );
  assert.throws(
    () => parseDetectJobItemParams('model_file_scan', { source: 'ftp', path: '/x' }, 0),
    isStatus(400),
  );
  assert.throws(
    () => parseDetectJobItemParams('model_file_scan', { source: 'library', path: '/x' }, 0),
    isStatus(400),
  );
});

// ---- 启动函数 ----

test('评估任务：带样本库建出排队中的任务', async () => {
  const out = await inPlatform(() =>
    DEFAULT_LAUNCHERS.eval_task(
      parseDetectJobItemParams('eval_task', {
        modelTargetId: targetId,
        questionSetIds: [questionSetId],
      }),
      ctx(admin, `${P}评估`),
    ),
  );
  assert.equal(out.recordKind, DETECT_JOB_ITEM_META.eval_task.recordKind);
  const task = await prisma.evalTask.findUniqueOrThrow({
    where: { id: out.recordId },
    include: { questionSets: true },
  });
  assert.equal(task.status, 'PENDING');
  assert.equal(task.name, `${P}评估`);
  assert.equal(task.totalQuestions, 2);
  assert.deepEqual(
    task.questionSets.map((s) => s.questionSetId),
    [questionSetId],
  );
  assert.equal(task.createdById, admin.id);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'eval_task.create', targetId: out.recordId },
  });
  assert.equal((audit?.detail as Record<string, unknown>)?.source, 'detect_job');
});

test('模型文件：允许目录里的目录扫描建出排队中的扫描；目录不在允许范围 400', async () => {
  const out = await inPlatform(() =>
    DEFAULT_LAUNCHERS.model_file_scan(
      parseDetectJobItemParams('model_file_scan', {
        source: 'directory',
        path: join(base, 'models'),
      }),
      ctx(admin),
    ),
  );
  assert.equal(out.recordKind, DETECT_JOB_ITEM_META.model_file_scan.recordKind);
  const scan = await prisma.modelFileScan.findUniqueOrThrow({ where: { id: out.recordId } });
  assert.equal(scan.status, 'PENDING');
  assert.equal(scan.source, 'DIRECTORY');
  assert.equal(scan.createdById, admin.id);
  await assert.rejects(
    inPlatform(() =>
      DEFAULT_LAUNCHERS.model_file_scan(
        parseDetectJobItemParams('model_file_scan', { source: 'directory', path: '/etc' }),
        ctx(admin),
      ),
    ),
    isStatus(400, 'MODEL_FILE_PATH_REJECTED'),
  );
});

test('语料：重扫复制原文件建新扫描，sha256 相同、存储位置不同；接口 POST /:id/rescan 也能用', async () => {
  const sourceId = await uploadCorpus('重扫.jsonl', '{"instruction":"你好","output":"好的"}\n');
  const out = await inPlatform(() =>
    DEFAULT_LAUNCHERS.corpus_scan(
      parseDetectJobItemParams('corpus_scan', { sourceScanId: sourceId }),
      ctx(admin),
    ),
  );
  assert.equal(out.recordKind, DETECT_JOB_ITEM_META.corpus_scan.recordKind);
  const [src, copy] = await Promise.all([
    prisma.corpusScan.findUniqueOrThrow({ where: { id: sourceId } }),
    prisma.corpusScan.findUniqueOrThrow({ where: { id: out.recordId } }),
  ]);
  assert.equal(copy.sha256, src.sha256);
  assert.notEqual(copy.storageKey, src.storageKey);
  assert.equal(copy.fileName, src.fileName);
  assert.equal(copy.format, src.format);
  assert.equal(copy.status, 'PENDING');

  const viaRoute = await app.inject({
    method: 'POST',
    url: `/api/corpus-scans/${sourceId}/rescan`,
    headers: bearer(adminToken),
    payload: {},
  });
  assert.equal(viaRoute.statusCode, 201, viaRoute.body);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'corpus_scan.create', targetId: viaRoute.json().id },
  });
  assert.equal((audit?.detail as Record<string, unknown>)?.sourceScanId, sourceId);
});

test('语料：原文件已清理时重扫 409 CORPUS_SOURCE_PURGED', async () => {
  const sourceId = await uploadCorpus('已清理.jsonl', '{"instruction":"a","output":"b"}\n');
  await prisma.corpusScan.update({ where: { id: sourceId }, data: { filesPurgedAt: new Date() } });
  await assert.rejects(
    inPlatform(() =>
      DEFAULT_LAUNCHERS.corpus_scan(
        parseDetectJobItemParams('corpus_scan', { sourceScanId: sourceId }),
        ctx(admin),
      ),
    ),
    isStatus(409, 'CORPUS_SOURCE_PURGED'),
  );
});

test('资产测绘：在扫描范围内建出测绘记录并在本进程执行', async () => {
  let done: Promise<void> | null = null;
  const run = await inPlatform(() =>
    startAssetDiscoveryRun(
      { id: admin.id, username: admin.username },
      { targets: ['127.0.0.1'], ports: [9] },
      {
        ip: '127.0.0.1',
        execute: { hostIntervalMs: 0, probe: { timeoutMs: 300 } },
        onRunStarted: (_id, p) => {
          done = p;
        },
      },
    ),
  );
  assert.ok(done, '后台执行已启动');
  await done;
  const row = await prisma.assetDiscoveryRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.createdById, admin.id);
  await assert.rejects(
    inPlatform(() =>
      startAssetDiscoveryRun(
        { id: admin.id, username: admin.username },
        { targets: ['10.9.9.9'], ports: [9] },
        { ip: null },
      ),
    ),
    isStatus(403, 'ASSET_DISCOVERY_OUT_OF_SCOPE'),
  );
  assert.equal(DETECT_JOB_ITEM_META.asset_discovery.recordKind, 'asset_discovery');
});

test('终端体检：按最新上报建出体检任务，记录类型是终端测评', async () => {
  const endpoint = await prisma.fleetEndpoint.create({
    data: {
      publicId: `ep_${randomBytes(10).toString('hex')}`,
      installationId: randomUUID(),
      machineId: `m-${P}`,
      hostname: `${P}host`,
      os: 'linux',
      osUser: 'tester',
      capabilities: ['asset_snapshot'],
      tokenHash: createHash('sha256').update(randomBytes(8)).digest('hex'),
      lastSeenAt: new Date(),
    },
  });
  await prisma.fleetProbeReport.create({
    data: {
      endpointId: endpoint.id,
      reportId: `pr_${randomBytes(16).toString('hex')}`,
      scannedAt: new Date(),
      status: 'complete',
      assetCount: 1,
      bodyHash: 'h',
      body: sampleReport({ bypass: true }),
    },
  });
  const out = await inPlatform(() =>
    DEFAULT_LAUNCHERS.fleet_posture(
      parseDetectJobItemParams('fleet_posture', { endpointId: endpoint.id }),
      ctx(admin, `${P}体检`),
    ),
  );
  assert.equal(out.recordKind, DETECT_JOB_ITEM_META.fleet_posture.recordKind);
  assert.equal(out.recordKind, 'fleet_eval_job');
  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: out.recordId } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.name, `${P}体检`);
  assert.ok(task.engines.includes('endpoint-agent-eval'));
});

// ---- 记录操作 ----

test('supportedActions：按类型和状态给出可用操作', () => {
  const expectEval: Record<string, string[]> = {
    PENDING: ['pause', 'stop'],
    RUNNING: ['pause', 'stop'],
    PAUSED: ['resume', 'stop'],
    COMPLETED: [],
    FAILED: [],
    CANCELED: [],
  };
  const expectStopOnly: Record<string, string[]> = {
    PENDING: ['stop'],
    RUNNING: ['stop'],
    PAUSED: [],
    COMPLETED: [],
    FAILED: [],
    CANCELED: [],
  };
  for (const s of DETECT_TASK_STATUSES) {
    assert.deepEqual(supportedActions('eval_task', s, { pausable: true }), expectEval[s], s);
    for (const kind of ['standard_run', 'rag_eval', 'fleet_eval_job'] as const) {
      assert.deepEqual(supportedActions(kind, s, { pausable: false }), expectStopOnly[s], kind + s);
    }
    assert.deepEqual(supportedActions('eval_task', s, { pausable: false }), expectStopOnly[s], s);
    assert.deepEqual(
      supportedActions('model_file_scan', s, { pausable: false }),
      expectStopOnly[s],
    );
    for (const kind of [
      'batch_evaluation',
      'corpus_scan',
      'asset_discovery',
      'service_assurance',
      'ai_component_scan',
    ] as const) {
      assert.deepEqual(supportedActions(kind, s, { pausable: false }), [], kind + s);
    }
  }
});

test('applyRecordAction：评估任务停止、模型文件停止；语料不支持 409；审计员暂停 403', async () => {
  const task = await prisma.evalTask.create({
    data: { name: `${P}待停止`, modelTargetId: targetId, status: 'PENDING' },
  });
  const stopped = await inPlatform(() =>
    applyRecordAction(admin, 'eval_task', task.id, 'stop', {
      cancelEvalTask: async () => undefined,
    }),
  );
  assert.equal(stopped.status, 'CANCELED');
  assert.equal(
    (await prisma.evalTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    'CANCELED',
  );

  const scan = await prisma.modelFileScan.create({
    data: {
      source: 'DIRECTORY',
      path: join(base, 'p2bb-launch-stop'),
      status: 'RUNNING',
      createdById: admin.id,
    },
  });
  const scanStopped = await inPlatform(() =>
    applyRecordAction(admin, 'model_file_scan', scan.id, 'stop'),
  );
  assert.equal(scanStopped.status, 'CANCELED');
  assert.equal(
    (await prisma.modelFileScan.findUniqueOrThrow({ where: { id: scan.id } })).status,
    'CANCELLED',
  );

  const corpusId = await uploadCorpus('不能停.jsonl', '{"instruction":"a","output":"b"}\n');
  await assert.rejects(
    inPlatform(() => applyRecordAction(admin, 'corpus_scan', corpusId, 'stop')),
    isStatus(409, 'DETECT_ACTION_UNSUPPORTED'),
  );
  // 已结束的评估任务再停止：同样不支持
  await assert.rejects(
    inPlatform(() => applyRecordAction(admin, 'eval_task', task.id, 'stop')),
    isStatus(409, 'DETECT_ACTION_UNSUPPORTED'),
  );

  const pending = await prisma.evalTask.create({
    data: { name: `${P}审计员`, modelTargetId: targetId, status: 'PENDING' },
  });
  await assert.rejects(
    inPlatform(() => applyRecordAction(auditor, 'eval_task', pending.id, 'pause')),
    isStatus(403),
  );
  const paused = await inPlatform(() =>
    applyRecordAction(admin, 'eval_task', pending.id, 'pause', {
      pauseEvalTask: async () => undefined,
    }),
  );
  assert.equal(paused.status, 'PAUSED');
  const resumed = await inPlatform(() =>
    applyRecordAction(admin, 'eval_task', pending.id, 'resume'),
  );
  assert.equal(resumed.status, 'PENDING');
});

test('资产测绘参数：目标里有普通主机或网段时必须选端口，只有 URL 或「主机:端口」时可以不选', () => {
  const issuesOf = (err: unknown) =>
    ((err as AppError).details as { issues: Array<{ path: unknown[] }> }).issues;
  assert.throws(
    () =>
      parseDetectJobItemParams(
        'asset_discovery',
        { targets: ['10.0.0.0/30', 'http://10.0.0.9:11434'], confirm: true },
        2,
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /第 3 项.*端口/);
      assert.ok(issuesOf(err).some((i) => i.path[0] === 'ports'));
      return true;
    },
  );
  for (const targets of [['http://10.0.0.9:11434'], ['10.0.0.9:8000']]) {
    assert.doesNotThrow(() =>
      parseDetectJobItemParams('asset_discovery', { targets, ports: [], confirm: true }),
    );
  }
  assert.throws(
    () =>
      parseDetectJobItemParams('asset_discovery', {
        targets: ['bad host!'],
        ports: [80],
        confirm: true,
      }),
    (err: unknown) => {
      assert.ok(issuesOf(err).some((i) => i.path[0] === 'targets'));
      return true;
    },
  );
});

test('supportedActions：暂停中（已请求暂停、还没停下）的评估任务可以撤销暂停', () => {
  assert.deepEqual(
    supportedActions('eval_task', 'RUNNING', { pausable: true, pauseRequested: true }),
    ['resume', 'stop'],
  );
  assert.deepEqual(supportedActions('eval_task', 'RUNNING', { pausable: true }), ['pause', 'stop']);
});
