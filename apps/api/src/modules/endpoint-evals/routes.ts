import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import { writeAudit } from '../../lib/audit.js';
import { AgentShieldClient, verifySignature } from './agentshield-client.js';
import {
  callbackSchema,
  endpointAccessConfigSchema,
  endpointEvalEnabled,
  endpointProductSchema,
  liveRiskTypesSchema,
} from './config.js';
import { buildEndpointPack } from './pack.js';
import { judgePosture } from './posture-judge.js';
import {
  applyEndpointUpdate,
  callbackReceipt,
  createQuestions,
  ENDPOINT_ENGINE,
  JOB_LOG,
  json,
  STATUS_LABELS,
} from './service.js';
import { pollEndpointJobs } from './poller.js';

const requestSchema = z.object({
  modelTargetId: z.string().uuid(),
  riskTypes: liveRiskTypesSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  reason: z.string().max(500).default('终端智能体安全测评'),
});
function enabled() {
  if (!endpointEvalEnabled()) throw notFound('终端智能体测评未启用');
}
const AGENTSHIELD_NOT_CONFIGURED_MESSAGE =
  '智能体安全平台地址未配置，请联系部署管理员在部署配置中设置';
const PUBLIC_BASE_URL_MESSAGE =
  '平台对外访问地址未配置或格式不正确，终端无法回传结果，请联系部署管理员在部署配置中设置';
function publicBaseUrl(): string {
  const url = new URL(process.env.LSE_PUBLIC_BASE_URL ?? '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw badRequest(PUBLIC_BASE_URL_MESSAGE);
  return url.origin;
}
export async function endpointEvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async () => {
    enabled();
  });
  // 只在本插件保留原始字节；验签在 JSON 解析之前完成。
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );
  const secured = [
    authenticate,
    requirePermission('eval_task:create'),
    requireLicensedFeature('web_ai'),
  ];
  const parseBody = (body: unknown) => {
    try {
      return typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      throw badRequest('请求体不是有效 JSON');
    }
  };
  app.addHook('preValidation', async (request) => {
    if (request.method === 'POST' && request.routeOptions.url !== '/api/endpoint-evals/callback')
      request.body = parseBody(request.body);
  });
  async function loadTarget(body: z.infer<typeof requestSchema>, userId: string, builtin: boolean) {
    const target = await prisma.modelTarget.findFirst({
      where: {
        id: body.modelTargetId,
        targetType: 'ENDPOINT_AGENT',
        isActive: true,
        ...(!builtin ? { OR: [{ isGlobal: true }, { createdById: userId }] } : {}),
      },
    });
    if (!target) throw notFound('可访问的终端智能体对象不存在');
    const config = endpointAccessConfigSchema.parse(target.accessConfig);
    const serverUrl = process.env.LSE_AGENTSHIELD_BASE_URL;
    if (!serverUrl) throw badRequest(AGENTSHIELD_NOT_CONFIGURED_MESSAGE);
    if (new URL(config.agentshieldBaseUrl).origin !== new URL(serverUrl).origin)
      throw badRequest(
        '该终端对象保存的智能体安全平台地址与当前部署不一致，请编辑对象重新选择终端',
      );
    return { target, config };
  }
  app.get(
    '/config',
    { preHandler: [authenticate, requirePermission('model_target:read')] },
    async () => ({ enabled: true, agentshieldBaseUrl: process.env.LSE_AGENTSHIELD_BASE_URL ?? '' }),
  );
  app.get(
    '/endpoints',
    { preHandler: [authenticate, requirePermission('model_target:create', 'eval_task:create')] },
    async (request) => {
      // AgentShield 连接器是全平台共用的一个实例，它的终端清单不属于任何租户：
      // 这一期只给平台租户看，其他租户返回空列表（界面上也不出现该来源）。
      if (!request.currentUser!.tenantIsPlatform) return [];
      const { product } = z
        .object({ product: endpointProductSchema.optional() })
        .parse(request.query);
      if (!process.env.LSE_AGENTSHIELD_BASE_URL)
        throw badRequest(AGENTSHIELD_NOT_CONFIGURED_MESSAGE);
      return new AgentShieldClient().endpoints(product);
    },
  );
  app.post('/posture', { preHandler: secured }, async (request, reply) => {
    const body = requestSchema.parse(parseBody(request.body));
    const { target, config } = await loadTarget(
      body,
      request.currentUser!.id,
      request.currentUser!.isBuiltin,
    );
    const posture = await new AgentShieldClient().posture(config.endpointId, config.product);
    if (posture.endpoint_id !== config.endpointId || posture.product !== config.product)
      throw badRequest('体检数据与终端对象不匹配');
    const findings = judgePosture(
      posture,
      (process.env.LSE_ENDPOINT_EVAL_MCP_ALLOWLIST ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const task = await prisma.$transaction(async (tx) => {
      const task = await tx.evalTask.create({
        data: {
          name: body.name ?? `${target.name} 配置体检`,
          description: '终端配置体检完成',
          modelTargetId: target.id,
          createdById: request.currentUser!.id,
          engines: [ENDPOINT_ENGINE],
          dimensions: ['agent_tool_call'],
          status: 'COMPLETED',
          totalQuestions: findings.length,
          processedQuestions: findings.length,
          passedCount: findings.filter((f) => f.verdict === 'PASS').length,
          failedCount: findings.filter((f) => f.verdict === 'FAIL').length,
          progress: 100,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      const questions = await createQuestions(
        tx,
        task,
        findings.map((f) => ({ id: f.ruleId, title: f.title, prompt: f.title })),
      );
      for (const [index, finding] of findings.entries()) {
        const result = await tx.evalResult.create({
          data: {
            taskId: task.id,
            questionId: questions[index]!.id,
            modelTargetId: target.id,
            prompt: finding.title,
            response: finding.evidence,
            finalVerdict: finding.verdict,
          },
        });
        await tx.finding.create({
          data: {
            taskId: task.id,
            questionId: result.questionId,
            resultId: result.id,
            engine: ENDPOINT_ENGINE,
            title: finding.title,
            riskCategory: finding.riskCategory,
            severity: finding.severity,
            verdict: finding.verdict,
            evidence: finding.evidence,
            detail: json({
              ruleId: finding.ruleId,
              compliance: finding.compliance,
              collected_at: posture.collected_at ?? null,
              source: 'agentshield-posture',
            }),
          },
        });
      }
      return task;
    });
    await writeAudit({
      actorId: request.currentUser!.id,
      actorName: request.currentUser!.username,
      action: 'endpoint_eval.posture',
      targetType: 'eval_task',
      targetId: task.id,
      detail: { endpointId: config.endpointId },
    });
    return reply.code(201).send({ taskId: task.id, status: 'COMPLETED' });
  });
  app.post('/run', { preHandler: secured }, async (request, reply) => {
    const body = requestSchema.parse(parseBody(request.body));
    const { target, config } = await loadTarget(
      body,
      request.currentUser!.id,
      request.currentUser!.isBuiltin,
    );
    const endpoints = await new AgentShieldClient().endpoints(config.product);
    const endpoint = endpoints.find((e) => e.endpoint_id === config.endpointId);
    if (
      !endpoint ||
      !endpoint.eval_runner_version ||
      !endpoint.agents.some((a) => a.product === config.product && a.headless_capable)
    )
      throw badRequest('端点不支持真机测评，仅可体检');
    const base = publicBaseUrl();
    const runToken = randomBytes(24).toString('hex');
    const sink = `${base}/sink/${runToken}`;
    const pack = buildEndpointPack(sink, body.riskTypes);
    const task = await prisma.$transaction(async (tx) => {
      const task = await tx.evalTask.create({
        data: {
          name: body.name ?? `${target.name} 真机测评`,
          description: STATUS_LABELS.pending_approval,
          modelTargetId: target.id,
          createdById: request.currentUser!.id,
          engines: [ENDPOINT_ENGINE],
          dimensions: ['agent_tool_call'],
          totalQuestions: pack.scenarios.length,
        },
      });
      await createQuestions(
        tx,
        task,
        pack.scenarios.map((s) => ({ id: s.scenario_id, title: s.title, prompt: s.prompt })),
      );
      await tx.evalTaskLog.create({
        data: {
          taskId: task.id,
          message: JOB_LOG,
          context: json({ jobId: '', product: config.product, runToken, pack }),
        },
      });
      return task;
    });
    try {
      const job = await new AgentShieldClient().createJob({
        lse_task_id: task.id,
        endpoint_id: config.endpointId,
        product: config.product,
        scenario_pack: pack,
        sink_base_url: sink,
        callback_url: `${base}/api/endpoint-evals/callback`,
        requested_by: request.currentUser!.username,
        reason: body.reason,
      });
      if (!job.job_id || job.status !== 'pending_approval')
        throw new Error('连接器创建任务响应无效');
      await prisma.evalTaskLog.updateMany({
        where: { taskId: task.id, message: JOB_LOG },
        data: { context: json({ jobId: job.job_id, product: config.product, runToken, pack }) },
      });
      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'endpoint_eval.run',
        targetType: 'eval_task',
        targetId: task.id,
        detail: { endpointId: config.endpointId, jobId: job.job_id },
      });
    } catch (error) {
      await prisma.evalTask.update({
        where: { id: task.id },
        data: {
          status: 'FAILED',
          description: '连接器任务创建失败，请检查连接后重新发起',
          finishedAt: new Date(),
        },
      });
      throw error;
    }
    return reply.code(201).send({
      taskId: task.id,
      status: 'pending_approval',
      statusLabel: STATUS_LABELS.pending_approval,
    });
  });
  app.post('/callback', { bodyLimit: 2.5 * 1024 * 1024 }, async (request) => {
    const ts = request.headers['x-lse-timestamp'];
    const signature = request.headers['x-lse-signature'];
    const body = typeof request.body === 'string' ? request.body : '';
    if (
      typeof ts !== 'string' ||
      typeof signature !== 'string' ||
      !verifySignature(
        process.env.LSE_ENDPOINT_EVAL_HMAC_SECRET ?? '',
        ts,
        signature,
        'POST',
        '/api/endpoint-evals/callback',
        body,
      )
    )
      throw unauthorized('终端回调签名无效或已过期');
    await applyEndpointUpdate(
      callbackSchema.parse(parseBody(body)),
      callbackReceipt(ts, signature),
    );
    return { ok: true };
  });
  let polling = false;
  const timer = setInterval(async () => {
    if (polling || !endpointEvalEnabled()) return;
    polling = true;
    try {
      await pollEndpointJobs((error) => app.log.warn({ err: error }, '终端测评轮询失败'));
    } catch (error) {
      app.log.warn({ err: error }, '终端测评轮询失败');
    } finally {
      polling = false;
    }
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
