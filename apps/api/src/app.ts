import { endpointEvalRoutes } from './modules/endpoint-evals/routes.js';
import { endpointSinkRoutes } from './modules/endpoint-evals/sink-routes.js';
import { fleetAgentRoutes, type FleetAgentRoutesOptions } from './modules/fleet-agent/routes.js';
import { fleetAdminRoutes } from './modules/fleet-admin/routes.js';
import type { RemoteDeployRoutesOptions } from './modules/fleet-admin/remote-deploy/routes.js';
import { agentSampleRoutes } from './modules/agent-samples/routes.js';
import { installFleetFinishHook } from './modules/fleet-admin/finish.js';
import { registerFleetJobFinishedHook } from './modules/fleet-agent/hooks.js';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
const productVersion: string = createRequire(import.meta.url)('../../../package.json').version;
import { config } from './config.js';
import { prisma } from './db.js';
import { AppError } from './lib/errors.js';
import { runInScope } from './lib/tenant-context.js';
import { tenantRoutes } from './modules/tenants/routes.js';
import type { CurrentUser } from './lib/rbac.js';
import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { roleRoutes } from './modules/roles/routes.js';
import { permissionRoutes } from './modules/permissions/routes.js';
import { licenseRoutes } from './modules/license/routes.js';
import { systemSettingRoutes } from './modules/system-settings/routes.js';
import { modelTargetRoutes } from './modules/model-targets/routes.js';
import { modelFingerprintRoutes } from './modules/model-fingerprint/routes.js';
import { questionSetRoutes } from './modules/question-sets/routes.js';
import { evalTaskRoutes } from './modules/eval-tasks/routes.js';
import { ciExportRoutes } from './modules/ci-export/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { frameworkRoutes } from './modules/frameworks/routes.js';
import { standardsRoutes } from './modules/standards/routes.js';
import { wrongAnswerRoutes } from './modules/wrong-answers/routes.js';
import { remediationRoutes } from './modules/remediation/routes.js';
import { engineRoutes } from './modules/engines/routes.js';
import { benchmarkRoutes } from './modules/benchmarks/routes.js';
import { generatorRoutes } from './modules/generator/routes.js';
import { agentEvalRoutes } from './modules/agent-evals/routes.js';
import { externalAssetAssessmentRoutes } from './modules/external-assets/routes.js';
import { gatewayLogRoutes } from './modules/gateway-logs/routes.js';
import { auditLogRoutes } from './modules/audit-logs/routes.js';
import { systemStatusRoutes } from './modules/system-status/routes.js';
import {
  serviceAssuranceRoutes,
  type ServiceAssuranceRoutesOptions,
} from './modules/service-assurance/routes.js';
import { standardEvaluationRoutes } from './modules/standard-evaluations/routes.js';
import { batchEvaluationRoutes } from './modules/batch-evaluations/routes.js';
import { modelFileRoutes } from './modules/model-files/routes.js';
import {
  assetDiscoveryRoutes,
  type AssetDiscoveryRouteOptions,
} from './modules/asset-discovery/routes.js';
import { brandingRoutes } from './modules/branding/routes.js';
import { publicRoutes } from './modules/public/routes.js';
import { resetPublicRedis } from './lib/public-rate-limit.js';
import { evaluationConfigRoutes } from './modules/evaluation-config/routes.js';
import { dataSecurityRoutes } from './modules/data-security/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { appProfileRoutes, detectResultsRoutes } from './modules/detect-risks/routes.js';
import { apiTokenRoutes } from './modules/api-tokens/routes.js';
import { gateRoutes } from './modules/gates/routes.js';
import { evalPlanRoutes } from './modules/eval-plans/routes.js';
import { dictionaryRoutes } from './modules/dictionaries/routes.js';
import { supportTicketRoutes } from './modules/support-tickets/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { toolRoutes } from './modules/tools/routes.js';
import { corpusRuleRoutes } from './modules/corpus-scans/rules-routes.js';
import { corpusScanRoutes } from './modules/corpus-scans/routes.js';
import { detectJobRoutes } from './modules/detect-jobs/routes.js';
import { detectStrategyRoutes } from './modules/detect-jobs/strategy-routes.js';
import { detectTaskRoutes } from './modules/detect-tasks/routes.js';
import { reportTemplateRoutes } from './modules/reports/template-routes.js';
import type { DetectStrategyScheduler } from './modules/detect-jobs/strategy-scheduler.js';
import { configureDetectJobRuntime } from './modules/detect-jobs/orchestrator.js';
import type { Launchers } from './modules/detect-jobs/launchers.js';
import { ledgerRoutes } from './modules/ledger/routes.js';
import { detectSchemeRoutes } from './modules/detect-schemes/routes.js';
import { closeEvalPlanQueue, type PlanScheduler } from './modules/eval-plans/scheduler.js';
import {
  policySuggestionRoutes,
  type PolicySuggestionRoutesOptions,
} from './modules/policy-suggestions/routes.js';
import { ragEvalRoutes, type RagEvalRoutesOptions } from './modules/rag-eval/routes.js';
import { closeQueue, requestEvalTaskCancel, requestEvalTaskPause } from './lib/queue.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string };
    user: { sub: string; username: string };
  }
}

const isTest = process.env.LSE_TEST === '1' || config.NODE_ENV === 'test';

export interface BuildAppOptions {
  cancelEvalTask?: (taskId: string) => Promise<void>;
  /** 评估任务暂停信号（2.4.2），测试注入。 */
  pauseEvalTask?: (taskId: string) => Promise<void>;
  serviceAssurance?: ServiceAssuranceRoutesOptions;
  evalPlanScheduler?: PlanScheduler;
  policySuggestions?: PolicySuggestionRoutesOptions;
  assetDiscovery?: AssetDiscoveryRouteOptions;
  ragEval?: RagEvalRoutesOptions;
  fleetAgent?: FleetAgentRoutesOptions;
  /** 组合任务（2.4.9）：测试注入假启动函数。 */
  detectJobs?: { launchers?: Partial<Launchers> };
  /** 检测策略调度（2.4.3）：测试注入，默认 BullMQ（测试环境空实现）。 */
  detectStrategyScheduler?: DetectStrategyScheduler;
  /** 远程部署（2.4.8）：测试注入假的 SSH 实现。 */
  remoteDeploy?: RemoteDeployRoutesOptions;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest ? false : { level: 'info' },
    // 只信紧挨着的一跳（标准部署前面是 Caddy）：客户端自带的 X-Forwarded-For 伪造多跳不影响按 IP 限流和审计。
    trustProxy: 1,
    bodyLimit: 16 * 1024 * 1024,
  });
  app.addHook('onClose', async () => {
    await closeEvalPlanQueue();
    await closeQueue();
    await resetPublicRedis();
  });

  // 错误处理器与 404 处理器必须在注册任何路由插件之前设置：
  // Fastify v5 中，路由插件创建的封装子上下文在注册时即捕获当时的错误处理器，
  // 若 setErrorHandler 在 register 之后调用，子上下文不会继承它（ZodError 会回退到默认 500）。
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { message: '接口不存在', code: 'NOT_FOUND' } });
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({
        error: { message: '参数校验失败', code: 'VALIDATION_ERROR', issues: err.issues },
      });
    }
    if (err instanceof AppError) {
      reply.code(err.statusCode);
      return reply.send({ error: { message: err.message, code: err.code, details: err.details } });
    }
    // 把 Prisma 的两个常见错误翻成业务语义：查/改不到 → 404，唯一键撞车 → 409。
    // 多租户下「按 ID 改别人的行」也走这里，不应该让调用方看到 500。
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        reply.code(404);
        return reply.send({
          error: { message: '记录不存在或已被删除', code: 'NOT_FOUND' },
        });
      }
      if (err.code === 'P2002') {
        reply.code(409);
        return reply.send({
          error: { message: '记录已存在，请勿重复提交', code: 'CONFLICT' },
        });
      }
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) request.log.error(err);
    reply.code(status);
    return reply.send({
      error: {
        message:
          status >= 500 && config.NODE_ENV !== 'development' ? '服务器内部错误' : err.message,
        code: err.code ?? 'INTERNAL_ERROR',
      },
    });
  });

  // 多租户：每个请求建立自己的租户上下文（AsyncLocalStorage），authenticate 解析用户后写入租户。
  // 放在 preHandler（请求体解析之后）而不是 onRequest：读请求体的回调不在 onRequest 的异步上下文里，
  // 放早了 POST 请求会丢上下文。少数在 onRequest 里鉴权的路由，这里沿用它已解析好的 request.tenantScope。
  app.addHook('preHandler', (request, _reply, done) => {
    const scope = request.tenantScope;
    runInScope(
      {
        tenantId: scope?.tenantId ?? null,
        sharedWrite: scope?.sharedWrite ?? false,
        allTenants: scope?.allTenants ?? false,
      },
      done,
    );
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  app.get('/api/version', async () => ({
    product: 'llm-safety-eval-platform',
    version: productVersion,
    sourceCommit: process.env.LSE_SOURCE_COMMIT ?? 'unavailable',
    capabilities: ['eval_task_verdict'],
  }));

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'lse-api',
    version: productVersion,
    sourceCommit: process.env.LSE_SOURCE_COMMIT ?? 'unavailable',
    time: new Date().toISOString(),
  }));

  // 集成握手：带密钥校验（访问策略控制）。供网关「测试连接」带密钥探活，
  // 没有匹配密钥的伪造请求一律 401。密钥沿用数据通道共享密钥 NEWAPI_EVAL_INTEGRATION_TOKEN（不上界面）。
  app.get('/api/integration/handshake', async (request, reply) => {
    const expected = (process.env.NEWAPI_EVAL_INTEGRATION_TOKEN ?? '').trim();
    if (!expected) {
      reply.code(503);
      return {
        status: 'error',
        service: 'lse-api',
        error: '未配置集成密钥（NEWAPI_EVAL_INTEGRATION_TOKEN）',
      };
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.code(401);
      return { status: 'error', service: 'lse-api', error: 'unauthorized' };
    }
    let gatewayConfigured = false;
    try {
      const row = await prisma.systemSetting.findUnique({ where: { key: 'gateway' } });
      const val = (row?.value ?? null) as { gatewayBaseUrl?: unknown } | null;
      gatewayConfigured = Boolean(
        val && typeof val.gatewayBaseUrl === 'string' && val.gatewayBaseUrl.trim(),
      );
    } catch {
      /* DB 不可用时不阻断握手 */
    }
    // 互证回显：网关带 nonce 回连时原样返回（证明"网关配的地址 == 本实例"）。
    // 本端点保持被动——只读 query/DB，不发起任何外呼，确保互证链路不递归。
    const rawNonce =
      typeof (request.query as { nonce?: unknown } | undefined)?.nonce === 'string'
        ? ((request.query as { nonce?: string }).nonce ?? '').trim()
        : '';
    const nonce = /^[A-Za-z0-9]{8,64}$/.test(rawNonce) ? rawNonce : '';
    return {
      status: 'ok',
      service: 'lse-api',
      paired: true,
      gateway_configured: gatewayConfigured,
      ...(nonce ? { nonce } : {}),
    };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(tenantRoutes, { prefix: '/api/tenants' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.register(roleRoutes, { prefix: '/api/roles' });
  await app.register(permissionRoutes, { prefix: '/api/permissions' });
  await app.register(licenseRoutes, { prefix: '/api/license' });
  await app.register(systemSettingRoutes, { prefix: '/api/system-settings' });
  await app.register(modelTargetRoutes, { prefix: '/api/model-targets' });
  await app.register(modelFingerprintRoutes, { prefix: '/api/model-targets' });
  await app.register(questionSetRoutes, { prefix: '/api/question-sets' });
  await app.register(evalTaskRoutes, {
    prefix: '/api/eval-tasks',
    cancelEvalTask: options.cancelEvalTask ?? requestEvalTaskCancel,
    pauseEvalTask: options.pauseEvalTask ?? requestEvalTaskPause,
  });
  await app.register(ciExportRoutes, { prefix: '/api/eval-tasks' });
  await app.register(reportRoutes, { prefix: '/api/reports' });
  await app.register(frameworkRoutes, { prefix: '/api/frameworks' });
  await app.register(standardsRoutes, { prefix: '/api/standards' });
  await app.register(wrongAnswerRoutes, { prefix: '/api/wrong-answers' });
  await app.register(remediationRoutes, { prefix: '/api/remediation' });
  await app.register(engineRoutes, { prefix: '/api/engines' });
  await app.register(modelFileRoutes, { prefix: '/api/model-files' });
  await app.register(assetDiscoveryRoutes, {
    prefix: '/api/asset-discovery',
    ...options.assetDiscovery,
  });
  await app.register(benchmarkRoutes, { prefix: '/api/benchmarks' });
  await app.register(generatorRoutes, { prefix: '/api/generator' });
  await app.register(endpointEvalRoutes, { prefix: '/api/endpoint-evals' });
  await app.register(endpointSinkRoutes, { prefix: '/sink' });
  // 终端接入协议（采集器对接）：独立插件，自带令牌鉴权/错误处理/404，不走平台登录 JWT。
  await app.register(fleetAgentRoutes, { prefix: '/agent/v1', ...options.fleetAgent });
  await app.register(fleetAdminRoutes, {
    prefix: '/api/fleet',
    remoteDeploy: options.remoteDeploy,
  });
  await app.register(agentSampleRoutes, { prefix: '/api/agent-samples' });
  installFleetFinishHook(registerFleetJobFinishedHook);
  await app.register(agentEvalRoutes, { prefix: '/api/agent-evals' });
  await app.register(externalAssetAssessmentRoutes, { prefix: '/api/external-assets' });
  await app.register(gatewayLogRoutes, { prefix: '/api/gateway-logs' });
  await app.register(auditLogRoutes, { prefix: '/api/audit-logs' });
  await app.register(systemStatusRoutes, { prefix: '/api/system' });
  await app.register(serviceAssuranceRoutes, {
    prefix: '/api/service-assurance',
    ...options.serviceAssurance,
  });
  await app.register(standardEvaluationRoutes, { prefix: '/api' });
  await app.register(batchEvaluationRoutes, { prefix: '/api/batch-evaluations' });
  // 公开只读品牌接口（租户信息设置）：登录前的登录页/页签需要，无需鉴权。
  await app.register(brandingRoutes, { prefix: '/api/branding' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(evaluationConfigRoutes, { prefix: '/api/evaluation-config' });
  await app.register(dataSecurityRoutes, { prefix: '/api/data-security' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(detectResultsRoutes, { prefix: '/api/detect-results' });
  await app.register(appProfileRoutes, { prefix: '/api/app-profiles' });
  await app.register(apiTokenRoutes, { prefix: '/api/api-tokens' });
  await app.register(gateRoutes, { prefix: '/api/gates' });
  await app.register(evalPlanRoutes, {
    prefix: '/api/eval-plans',
    scheduler: options.evalPlanScheduler,
  });
  await app.register(policySuggestionRoutes, {
    prefix: '/api/policy-suggestions',
    ...options.policySuggestions,
  });
  await app.register(ragEvalRoutes, { prefix: '/api/rag-eval', ...options.ragEval });
  await app.register(dictionaryRoutes, { prefix: '/api/dictionaries' });
  await app.register(supportTicketRoutes, { prefix: '/api/support-tickets' });
  await app.register(toolRoutes, { prefix: '/api/tools' });
  await app.register(corpusRuleRoutes, { prefix: '/api/corpus-rules' });
  await app.register(corpusScanRoutes, { prefix: '/api/corpus-scans' });
  // 组合任务的启动函数和暂停、取消信号：API 里的启动、恢复、停止，以及检测方案建任务都走这里。
  configureDetectJobRuntime({
    launchers: options.detectJobs?.launchers,
    pauseEvalTask: options.pauseEvalTask,
    cancelEvalTask: options.cancelEvalTask,
  });
  await app.register(detectJobRoutes, { prefix: '/api/detect-jobs' });
  await app.register(ledgerRoutes, { prefix: '/api/ledger' });
  await app.register(detectSchemeRoutes, { prefix: '/api/detect-schemes' });
  await app.register(detectStrategyRoutes, {
    prefix: '/api/detect-strategies',
    scheduler: options.detectStrategyScheduler,
  });
  await app.register(detectTaskRoutes, { prefix: '/api/detect-tasks' });
  await app.register(reportTemplateRoutes, { prefix: '/api/report-templates' });

  return app;
}
