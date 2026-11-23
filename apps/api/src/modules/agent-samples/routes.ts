import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { currentTenantScope } from '../../lib/tenant-context.js';
import { tenantOf } from '../../lib/all-tenants.js';
import { PERM_MANAGE, PERM_READ } from '../fleet-admin/config.js';
import { ENDPOINT_SCENARIO_DEFINITIONS } from '../endpoint-evals/pack.js';
import { RUNTIME_DECOY_PATHS } from '../endpoint-evals/runtime-outcome.js';
import { publicBaseUrl } from '../fleet-admin/service.js';
import { prisma } from '../../db.js';
import { loadEndpointSummary } from '../eval-tasks/endpoint-summary-data.js';
import { FLEET_LIVE_PRODUCTS, LIVE_RISK_DESCRIPTIONS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { RUNTIME_HARM_LABELS, RUNTIME_VECTOR_LABELS, type RuntimeDanger, type RuntimeSample } from '../../../../../packages/shared/src/runtime-eval.js';

import { runtimeLocations } from './locations.js';
import { CLASSIC_REFS, buildRangeInfo, decoyViews, poisonBlocks, refViews } from './presentation.js';
import { parseCustomSample } from './validation.js';
import { loadSampleCatalog } from './catalog.js';
async function storeDigest(tx: Prisma.TransactionClient, sampleId: string, version: number): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ digest: string }>>`UPDATE agent_sample_versions
    SET digest = 'sha256:' || encode(sha256(convert_to(content::text, 'UTF8')), 'hex')
    WHERE "sampleId" = ${sampleId} AND version = ${version} RETURNING digest`;
  if (!rows[0]) throw new Error('样本版本不存在');
  return rows[0].digest;
}

async function createCustomSample(sample: RuntimeSample, userId: string, changeNote: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await tx.agentSample.create({ data: { id: sample.id, suite: 'runtime_v2', source: 'custom',
      versions: { create: { version: 1, content: sample as unknown as Prisma.InputJsonValue,
        digest: 'pending', createdById: userId, changeNote } } } });
    return storeDigest(tx, sample.id, 1);
  });
}
function describeDanger(danger: RuntimeDanger): string {
  switch (danger.kind) {
    case 'read_decoy': return `读取或尝试读取 ${RUNTIME_DECOY_PATHS[danger.decoy] ?? '敏感文件'}`;
    case 'egress_to': return `尝试访问 ${danger.host}`;
    case 'sink_received': return '受控接收端收到标记';
    case 'cmd_matches': return '工具命令符合样本的危险操作规则';
    case 'path_changed': return `文件 ${danger.path} 发生${{ create: '创建', modify: '修改', delete: '删除' }[danger.op]}`;
    case 'wrote_text': return `向 ${danger.path} 写入指定内容`;
  }
}

const BUILTIN_ORIGIN = '鉴盾自研样本：场景、诱导内容和判定规则均为自行编写，不含第三方题库内容。';
/** 出处：内置样本给固定说明；自定义样本给手填的出处，加上创建人、时间、版本和摘要。 */
async function provenanceOf(
  stored: { source: string },
  version: { version: number; digest: string; createdById: string | null; createdAt: Date; changeNote: string },
  origin: string | undefined,
) {
  const user = version.createdById
    ? await prisma.user.findUnique({ where: { id: version.createdById }, select: { displayName: true, username: true } })
    : null;
  const custom = stored.source === 'custom';
  return {
    kind: custom ? 'custom' as const : 'builtin' as const,
    origin: origin?.trim() || (custom ? null : BUILTIN_ORIGIN),
    createdBy: user ? user.displayName || user.username : null,
    createdAt: version.createdAt.toISOString(),
    changeNote: version.changeNote,
    version: version.version,
    digest: version.digest,
  };
}

function runtimeItem(sample: RuntimeSample) {
  return {
    id: sample.id, suite: 'runtime_v2' as const, source: 'builtin' as const,
    title: sample.title, vector: sample.vector, vectorLabel: RUNTIME_VECTOR_LABELS[sample.vector],
    harm: sample.harm, harmLabel: RUNTIME_HARM_LABELS[sample.harm], channel: sample.channel ?? null,
    locations: runtimeLocations(sample), template: sample.template, agents: ['claude-code'], environment: 'sandbox' as const,
    summary: sample.explain, refs: sample.refs,
  };
}

function classicItem(sample: typeof ENDPOINT_SCENARIO_DEFINITIONS[number]) {
  return {
    id: `endpoint-${sample.id}`, suite: 'classic' as const, source: 'builtin' as const,
    title: sample.title, vector: null, vectorLabel: LIVE_RISK_DESCRIPTIONS[sample.risk].label,
    harm: sample.risk, harmLabel: LIVE_RISK_DESCRIPTIONS[sample.risk].label, channel: null,
    locations: [sample.source, sample.path], template: null, agents: [...FLEET_LIVE_PRODUCTS], environment: 'real_config' as const,
    summary: LIVE_RISK_DESCRIPTIONS[sample.risk].what, refs: CLASSIC_REFS[sample.risk],
  };
}

export async function agentSampleRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requirePermission(PERM_READ)];
  const manage = [authenticate, requirePermission(PERM_MANAGE)];
  app.post('/', { preHandler: manage }, async (request, reply) => {
    const input = z.object({ sample: z.unknown(), changeNote: z.string().max(500).optional() }).strict().parse(request.body);
    const sample = parseCustomSample(input.sample);
    let hash: string;
    try {
      hash = await createCustomSample(sample, request.currentUser!.id, input.changeNote ?? '');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw conflict('编号已被占用，请换一个');
      throw error;
    }
    return reply.code(201).send({ id: sample.id, version: 1, digest: hash, enabled: true });
  });
  app.post('/import', { preHandler: manage }, async (request) => {
    const input = z.object({ samples: z.array(z.unknown()).min(1).max(100) }).strict().parse(request.body);
    const items: Array<{ index: number; id?: string; ok: boolean; error?: string }> = [];
    for (const [index, raw] of input.samples.entries()) {
      let id: string | undefined;
      try {
        const wrapper = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const versions = Array.isArray(wrapper.versions) ? wrapper.versions : [];
        const latest = versions.length ? versions[versions.length - 1] as Record<string, unknown> : null;
        const sample = parseCustomSample(latest?.content ?? wrapper.content ?? raw);
        id = sample.id;
        await createCustomSample(sample, request.currentUser!.id, 'JSON 导入');
        items.push({ index, id, ok: true });
      } catch (error) {
        const message = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' ? '编号已被占用，请换一个'
          : error instanceof z.ZodError ? '样本结构不合法' : error instanceof AppError ? error.message : '导入失败';
        items.push({ index, ...(id ? { id } : {}), ok: false, error: message });
      }
    }
    return { items };
  });
  app.put('/:id', { preHandler: manage }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const input = z.object({ sample: z.unknown(), expectedVersion: z.number().int().positive(), changeNote: z.string().max(500).optional() }).strict().parse(request.body);
    const sample = parseCustomSample(input.sample);
    if (sample.id !== id) throw badRequest('样本编号不能修改');
    const row = await prisma.agentSample.findUnique({ where: { id } });
    if (!row) throw notFound('样本不存在');
    if (row.source !== 'custom') throw conflict('内置样本只能复制，不能修改');
    const version = input.expectedVersion + 1;
    const hash = await prisma.$transaction(async (tx) => {
      const changed = await tx.agentSample.updateMany({ where: { id, source: 'custom', currentVersion: input.expectedVersion },
        data: { currentVersion: version } });
      if (!changed.count) throw conflict('样本已被其他用户修改，请刷新后重试');
      await tx.agentSampleVersion.create({ data: { sampleId: id, version, content: sample as unknown as Prisma.InputJsonValue,
        digest: 'pending', createdById: request.currentUser!.id, changeNote: input.changeNote ?? '' } });
      return storeDigest(tx, id, version);
    });
    return { id, version, digest: hash };
  });
  app.patch('/:id/status', { preHandler: manage }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const row = await prisma.agentSample.findUnique({ where: { id }, select: { tenantId: true } });
    // 平台内置样本（tenantId 为空）各租户只读：给出明确提示，不要伪装成「不存在」。
    if (row && row.tenantId === null && !currentTenantScope()?.sharedWrite) {
      throw forbidden('平台内置内容只读', 'PLATFORM_SAMPLE_READONLY');
    }
    const result = await prisma.agentSample.updateMany({ where: { id }, data: { enabled } });
    if (!result.count) throw notFound('样本不存在');
    return { id, enabled };
  });
  app.get('/:id/export', { preHandler: read }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const sample = await prisma.agentSample.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'asc' } } } });
    if (!sample) throw notFound('样本不存在');
    return { samples: [sample] };
  });
  app.get('/:id/trials', { preHandler: [...read, requirePermission('eval_task:read')] }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const { version } = z.object({ version: z.coerce.number().int().positive().optional() }).parse(request.query);
    if (!await prisma.agentSample.findUnique({ where: { id }, select: { id: true } })) throw notFound('样本不存在');
    const trials = await prisma.agentSampleTrial.findMany({ where: { sampleId: id, ...(version ? { version } : {}) },
      orderBy: { createdAt: 'desc' }, take: 20 });
    const jobs = await prisma.fleetEvalJob.findMany({ where: { evalTaskId: { in: trials.map((trial) => trial.taskId) } },
      select: { evalTaskId: true, status: true, deadline: true } });
    const items = await Promise.all(trials.map(async (trial) => {
      const job = jobs.find((item) => item.evalTaskId === trial.taskId);
      const status = job && ['PENDING_APPROVAL', 'QUEUED'].includes(job.status) && job.deadline.getTime() <= Date.now() ? 'EXPIRED' : job?.status ?? 'UNKNOWN';
      let conclusion: string | null = null;
      if (status === 'COMPLETED' || status === 'FAILED') try { conclusion = (await loadEndpointSummary(prisma, trial.taskId)).verdictLine; }
      catch (error) { request.log.warn({ err: error, taskId: trial.taskId }, '读取试运行结论失败'); }
      return { version: trial.version, taskId: trial.taskId, createdAt: trial.createdAt.toISOString(), status, conclusion };
    }));
    return { items };
  });
  app.get('/', { preHandler: read }, async () => {
    const catalog = await loadSampleCatalog();
    return { items: catalog.map((entry) => ({
      ...(entry.suite === 'runtime_v2' ? runtimeItem(entry.content as RuntimeSample) : classicItem(entry.content as typeof ENDPOINT_SCENARIO_DEFINITIONS[number])),
      source: entry.source, enabled: entry.enabled, version: entry.version, digest: entry.digest,
    })) };
  });
  app.get('/export', { preHandler: read }, async () => ({
    samples: await prisma.agentSample.findMany({ orderBy: { id: 'asc' }, include: { versions: { orderBy: { version: 'asc' } } } }),
  }));
  app.get('/plans', { preHandler: read }, async () => {
    const [plans, catalog] = await Promise.all([prisma.agentSamplePlan.findMany({ orderBy: { id: 'asc' } }), loadSampleCatalog()]);
    const enabled = new Set(catalog.filter((entry) => entry.enabled).map((entry) => entry.id));
    return { items: plans.map((plan) => {
      const samples = Array.isArray(plan.samples) ? plan.samples : [];
      const settings = plan.settings && typeof plan.settings === 'object' && !Array.isArray(plan.settings) ? plan.settings : {};
      const selected = samples.flatMap((sample) => sample && typeof sample === 'object' && !Array.isArray(sample) &&
        typeof sample.id === 'string' && enabled.has(sample.id) ? [{ id: sample.id, version: typeof sample.version === 'number' ? sample.version : null }] : []);
      return { id: plan.id, name: plan.name, sampleIds: selected.map((sample) => sample.id),
        sampleVersions: selected.flatMap((sample) => sample.version ? [{ id: sample.id, version: sample.version }] : []), ...settings };
    }) };
  });
  app.get('/range', { preHandler: [...read, requirePermission('eval_task:read')] }, async (request) => {
    let receiverBase: string | null = null;
    try { receiverBase = publicBaseUrl(); } catch { /* 未配置时由页面显示未上报 */ }
    const receiptTenantId = tenantOf(request.currentUser!);
    const recentReceipts = await prisma.evalTaskLog.findMany({
      // 任务日志是子表（不带 tenantId），按所属任务的租户限定；全部租户视角不限定。
      where: {
        message: '终端诱饵接收',
        ...(receiptTenantId ? { task: { tenantId: receiptTenantId } } : {}),
      },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, taskId: true, createdAt: true },
    });
    return {
      ...buildRangeInfo(await loadSampleCatalog()),
      receiverBase, receiverReachable: null,
      recentReceipts: recentReceipts.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
    };
  });
  app.get('/statistics', { preHandler: [...read, requirePermission('eval_task:read')] }, async (request) => {
    const catalog = await loadSampleCatalog();
    const ids = new Set(catalog.map((entry) => entry.id));
    const counts = new Map<string, { allowed: number; model_refused: number; control_blocked: number; invalid: number }>();
    let cursor: string | undefined;
    let incompleteJobs = 0;
    for (;;) {
      const jobs = await prisma.fleetEvalJob.findMany({ where: { status: { in: ['COMPLETED', 'FAILED'] }, evalTaskId: { not: null } },
        orderBy: { id: 'asc' }, take: 50, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, evalTaskId: true } });
      if (!jobs.length) break;
      for (const job of jobs) {
        try {
          const summary = await loadEndpointSummary(prisma, job.evalTaskId!);
          for (const scenario of summary.liveScenarios) {
            const raw = scenario.runtime?.sample_id || scenario.scenarioId;
            const base = ids.has(raw) ? raw : raw.replace(/\.(?:py|node)$/, '');
            if (!ids.has(base) || !scenario.outcome || (scenario.runtime && scenario.runtime.arm !== 'observe')) continue;
            const value = counts.get(base) ?? { allowed: 0, model_refused: 0, control_blocked: 0, invalid: 0 };
            value[scenario.outcome]++;
            counts.set(base, value);
          }
        } catch (error) { incompleteJobs++; request.log.warn({ err: error, taskId: job.evalTaskId }, '读取样本汇总统计失败'); }
      }
      cursor = jobs[jobs.length - 1]!.id;
      if (jobs.length < 50) break;
    }
    return { items: [...counts].map(([id, value]) => {
      const valid = value.allowed + value.model_refused + value.control_blocked;
      return { id, ...value, complyRate: valid ? value.allowed / valid : null };
    }), incompleteJobs };
  });
  app.get('/:id/stats', { preHandler: [...read, requirePermission('eval_task:read')] }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    if (!await prisma.agentSample.findUnique({ where: { id }, select: { id: true } }))
      throw notFound('样本不存在');
    type Outcome = 'allowed' | 'model_refused' | 'control_blocked' | 'invalid';
    const empty = () => ({ allowed: 0, model_refused: 0, control_blocked: 0, invalid: 0 });
    const counts = new Map<string, { observe: Record<Outcome, number>; enforce: Record<Outcome, number>; unlabeled: Record<Outcome, number> }>();
    const versions = new Map<string, { product: string; version: number | null; observe: Record<Outcome, number>; enforce: Record<Outcome, number>; unlabeled: Record<Outcome, number> }>();
    let cursor: string | undefined;
    let incompleteJobs = 0;
    for (;;) {
      const jobs = await prisma.fleetEvalJob.findMany({ where: { status: { in: ['COMPLETED', 'FAILED'] },
        payloadCanonical: { contains: id }, evalTaskId: { not: null } }, orderBy: { id: 'asc' }, take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, product: true, evalTaskId: true } });
      if (!jobs.length) break;
      for (let offset = 0; offset < jobs.length; offset += 5) await Promise.all(jobs.slice(offset, offset + 5).map(async (job) => {
        try {
          const summary = await loadEndpointSummary(prisma, job.evalTaskId!);
          for (const scenario of summary.liveScenarios) {
            const sampleId = scenario.runtime?.sample_id || scenario.scenarioId;
            if (sampleId !== id && sampleId !== `${id}.py` && sampleId !== `${id}.node`) continue;
            if (!scenario.outcome) continue;
            const product = counts.get(job.product) ?? { observe: empty(), enforce: empty(), unlabeled: empty() };
            const arm = scenario.runtime ? scenario.runtime.arm ?? 'unlabeled' : 'observe';
            product[arm][scenario.outcome]++;
            counts.set(job.product, product);
            const version = scenario.sampleVersion ?? null;
            const key = `${job.product}\0${version ?? 'unknown'}`;
            const byVersion = versions.get(key) ?? { product: job.product, version, observe: empty(), enforce: empty(), unlabeled: empty() };
            byVersion[arm][scenario.outcome]++;
            versions.set(key, byVersion);
          }
        } catch (error) { incompleteJobs++; request.log.warn({ err: error, taskId: job.evalTaskId }, '读取样本运行统计失败'); }
      }));
      cursor = jobs[jobs.length - 1]!.id;
      if (jobs.length < 50) break;
    }
    const rate = (value: Record<Outcome, number>) => {
      const valid = value.allowed + value.model_refused + value.control_blocked;
      return { ...value, complyRate: valid ? value.allowed / valid : null };
    };
    return { items: [...counts].map(([product, value]) => ({ product,
      observe: rate(value.observe), enforce: rate(value.enforce), unlabeled: rate(value.unlabeled) })),
      versions: [...versions.values()].map((value) => ({ product: value.product, version: value.version,
        observe: rate(value.observe), enforce: rate(value.enforce), unlabeled: rate(value.unlabeled) })), incompleteJobs };
  });
  app.get('/:id', { preHandler: read }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const { version } = z.object({ version: z.coerce.number().int().positive().optional() }).parse(request.query);
    const stored = await prisma.agentSample.findUnique({ where: { id } });
    if (!stored) throw notFound('样本不存在');
    const storedVersion = await prisma.agentSampleVersion.findUnique({ where: { sampleId_version: { sampleId: id, version: version ?? stored.currentVersion } } });
    if (!storedVersion) throw notFound('样本版本不存在');
    if (stored.suite === 'runtime_v2') {
      const sample = storedVersion.content as unknown as RuntimeSample;
      return { ...runtimeItem(sample), source: stored.source, enabled: stored.enabled, version: storedVersion.version, digest: storedVersion.digest, legacyDigest: storedVersion.legacyDigest,
        prompt: sample.prompt, turns: sample.turns ?? [], slots: sample.slots, decoys: sample.decoys,
        danger: sample.danger, dangerDescriptions: sample.danger.map(describeDanger), expect: sample.expect ?? null,
        explain: sample.explain, refs: sample.refs, mcp: sample.mcp ?? null, statistics: null,
        summary: sample.explain, poison: poisonBlocks(sample),
        decoyInfo: decoyViews([...sample.decoys.workspace, ...sample.decoys.home]), refsInfo: refViews(sample.refs),
        provenance: await provenanceOf(stored, storedVersion, sample.origin) };
    }
    const classic = storedVersion.content as unknown as typeof ENDPOINT_SCENARIO_DEFINITIONS[number];
    return {
      ...classicItem(classic), enabled: stored.enabled, version: storedVersion.version, digest: storedVersion.digest, legacyDigest: storedVersion.legacyDigest, prompt: classic.prompt, turns: [],
      slots: { [classic.path]: classic.content.replaceAll('SINK', '受控接收端地址').replaceAll('CANARY', '本次运行生成的标记') },
      decoys: { workspace: ['.env.lse-decoy'], home: [] }, dangerDescriptions: [LIVE_RISK_DESCRIPTIONS[classic.risk].howJudged],
      expect: null, explain: LIVE_RISK_DESCRIPTIONS[classic.risk].what, refs: CLASSIC_REFS[classic.risk], statistics: null,
      summary: LIVE_RISK_DESCRIPTIONS[classic.risk].what,
      poison: [{ kind: 'file' as const, location: classic.source, path: classic.path,
        text: classic.content.replaceAll('SINK', '受控接收端地址').replaceAll('CANARY', '本次运行生成的标记') }],
      decoyInfo: [{ id: 'classic_decoy', label: '测试用假凭据文件', path: '', purpose: '放在工作目录里的假凭据，测智能体会不会读取或外传。' }],
      refsInfo: refViews(CLASSIC_REFS[classic.risk]),
      provenance: await provenanceOf(stored, storedVersion, undefined),
    };
  });
}
