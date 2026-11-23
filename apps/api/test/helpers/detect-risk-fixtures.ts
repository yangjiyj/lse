import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { prismaUnscoped } from '../../src/db.js';
import { ENDPOINT_ENGINE } from '../../src/modules/endpoint-evals/service.js';

// 四类风险口径（F 线）的测试夹具：同一租户里各来源都造一份，计数口径见 docs/detect-risk-categories.md。
// 预期：eval_content 2、eval_app 4（智能体 2 + 终端 2）、model_file 2、corpus 3、
// service_assurance 2、ai_component 1、asset_discovery 1。

export const RISK_FIXTURE_EXPECTED = {
  eval_content: 2,
  eval_app: 4,
  model_file: 2,
  corpus: 3,
  service_assurance: 2,
  ai_component: 1,
  asset_discovery: 1,
} as const;

/** 资产测绘命中的服务地址；登记的评估对象与它同源。 */
export const RISK_FIXTURE_SERVICE = 'http://10.98.7.6:11434';
export const RISK_FIXTURE_UNREGISTERED_MODEL = 'llama3:8b';
export const RISK_FIXTURE_REGISTERED_MODEL = 'qwen2:7b';

export interface DetectRiskFixture {
  tenantId: string;
  targets: { content: string; agent: string; endpoint: string; registered: string };
  tasks: { content: string; agent: string; endpoint: string };
  modelFileScanId: string;
  corpusScanId: string;
  serviceRunId: string;
  aiScanId: string;
  aiAssetKey: string;
  /** 两次资产测绘，第二次在后 */
  discoveryRunIds: [string, string];
}

async function target(
  tenantId: string,
  name: string,
  baseUrl = 'http://127.0.0.1:9/v1',
  model = 'risk-fixture',
) {
  const row = await prismaUnscoped.modelTarget.create({
    data: { tenantId, name, provider: 'openai-compatible', baseUrl, apiKey: 'none', model },
    select: { id: true },
  });
  return row.id;
}

async function task(
  tenantId: string,
  modelTargetId: string,
  name: string,
  engines: string[],
  dimensions: string[],
) {
  const row = await prismaUnscoped.evalTask.create({
    data: { tenantId, modelTargetId, name, engines, dimensions, status: 'COMPLETED' },
    select: { id: true },
  });
  return row.id;
}

type FindingSpec = {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  verdict?: 'PASS' | 'FAIL';
  falsePositive?: boolean;
  title?: string;
};

async function findings(tenantId: string, taskId: string, specs: FindingSpec[]) {
  await prismaUnscoped.finding.createMany({
    data: specs.map((s, i) => ({
      tenantId,
      taskId,
      engine: 'rule-judge',
      riskCategory: 'jailbreak',
      severity: s.severity,
      verdict: s.verdict ?? 'FAIL',
      reviewStatus: s.falsePositive ? 'FALSE_POSITIVE' : 'UNREVIEWED',
      title: s.title ?? `风险项 ${i + 1}`,
    })),
  });
}

/** 在指定租户里造一整套夹具；tag 用来区分名字（同一租户只造一次）。 */
export async function seedDetectRiskFixture(
  tenantId: string,
  tag: string,
): Promise<DetectRiskFixture> {
  const targets = {
    content: await target(tenantId, `${tag}内容对象`),
    agent: await target(tenantId, `${tag}智能体对象`),
    endpoint: await target(tenantId, `${tag}终端对象`),
    registered: await target(
      tenantId,
      `${tag}已登记服务`,
      `${RISK_FIXTURE_SERVICE}/v1`,
      RISK_FIXTURE_REGISTERED_MODEL,
    ),
  };
  const tasks = {
    content: await task(tenantId, targets.content, `${tag}内容评估`, [], []),
    agent: await task(tenantId, targets.agent, `${tag}智能体评估`, [], ['agent_tool_call']),
    endpoint: await task(
      tenantId,
      targets.endpoint,
      `${tag}终端体检`,
      [ENDPOINT_ENGINE],
      ['agent_tool_call'],
    ),
  };
  await findings(tenantId, tasks.content, [
    { severity: 'CRITICAL', title: '[rule-judge] 越狱' },
    { severity: 'MEDIUM' },
    { severity: 'HIGH', falsePositive: true },
  ]);
  await findings(tenantId, tasks.agent, [{ severity: 'HIGH' }, { severity: 'LOW' }]);
  await findings(tenantId, tasks.endpoint, [
    { severity: 'HIGH' },
    { severity: 'MEDIUM' },
    { severity: 'LOW', verdict: 'PASS' },
  ]);

  const modelFileScan = await prismaUnscoped.modelFileScan.create({
    data: {
      tenantId,
      source: 'DIRECTORY',
      path: `/models/${tag}`,
      targetId: targets.content,
      status: 'COMPLETED',
    },
    select: { id: true },
  });
  const modelFinding = (ruleId: string, severity: 'HIGH' | 'MEDIUM', fp = false) => ({
    tenantId,
    scanId: modelFileScan.id,
    filePath: `/models/${tag}/${ruleId.toLowerCase()}.pkl`,
    format: 'pickle',
    severity,
    ruleId,
    title: `原始标题 ${ruleId}`,
    evidence: 'os.system',
    reviewStatus: fp ? ('FALSE_POSITIVE' as const) : ('UNREVIEWED' as const),
  });
  await prismaUnscoped.modelFileFinding.createMany({
    data: [
      modelFinding('PICKLE_DANGEROUS_GLOBAL', 'HIGH'),
      modelFinding('PICKLE_UNLISTED_GLOBAL', 'MEDIUM'),
      modelFinding('PICKLE_UNSAFE_CALL', 'HIGH', true),
    ],
  });

  const corpusScan = await prismaUnscoped.corpusScan.create({
    data: {
      tenantId,
      fileName: `${tag}语料.jsonl`,
      storageKey: `p2bf-risk-${randomUUID()}`,
      bytes: BigInt(0),
      sha256: '0'.repeat(64),
      status: 'COMPLETED',
      findingCount: 4,
      storedFindings: 4,
    },
    select: { id: true },
  });
  const corpusSeverity = ['HIGH', 'MEDIUM', 'LOW', 'HIGH'];
  await prismaUnscoped.corpusFinding.createMany({
    data: [null, 'CONFIRMED', 'DISMISSED', 'ERROR'].map((judgeVerdict, i) => ({
      tenantId,
      scanId: corpusScan.id,
      recordIndex: i + 1,
      line: i + 1,
      fieldPath: 'output',
      category: 'sensitive',
      subtype: 'phone',
      subtypeLabel: i === 0 ? '手机号' : null,
      matchText: '13800000000',
      severity: corpusSeverity[i]!,
      judgeVerdict,
    })),
  });

  const run = await prismaUnscoped.serviceAssuranceRun.create({
    data: {
      tenantId,
      mode: 'SBOM',
      targetKind: 'SBOM',
      targetName: `${tag}核验目标`,
      scopePolicyRef: 'risk-fixture',
      status: 'COMPLETED',
      requestBudget: {},
    },
    select: { id: true },
  });
  const component = await prismaUnscoped.serviceComponent.create({
    data: {
      runId: run.id,
      name: 'vllm',
      source: 'SBOM',
      evidenceLevel: 'VERSION_MATCH',
      componentKey: `${tag}-vllm`,
    },
    select: { id: true },
  });
  const assessments = [
    {
      advisoryId: 'CVE-2026-1001',
      impactStatus: 'AFFECTED',
      evidenceLevel: 'VERSION_MATCH',
      severity: 'HIGH',
      componentId: component.id,
    },
    {
      advisoryId: null,
      impactStatus: 'UNDER_INVESTIGATION',
      evidenceLevel: 'CONFIG_MATCH',
      severity: null,
      componentId: null,
    },
    {
      advisoryId: 'CVE-2026-1002',
      impactStatus: 'NOT_AFFECTED',
      evidenceLevel: 'VERSION_MATCH',
      severity: 'CRITICAL',
      componentId: component.id,
    },
    {
      advisoryId: 'CVE-2026-1003',
      impactStatus: 'FIXED',
      evidenceLevel: 'VERSION_MATCH',
      severity: 'HIGH',
      componentId: component.id,
    },
  ] as const;
  await prismaUnscoped.vulnerabilityAssessment.createMany({
    data: assessments.map((a, i) => ({
      tenantId,
      runId: run.id,
      componentId: a.componentId,
      advisoryId: a.advisoryId,
      impactStatus: a.impactStatus,
      evidenceLevel: a.evidenceLevel,
      severity: a.severity,
      title: `研判 ${i + 1}`,
      reason: '夹具',
      assessmentKey: `k${i}`,
    })),
  });

  const aiAssetKey = `mcp:${tag.toLowerCase()}-server`;
  const aiScan = await prismaUnscoped.aiComponentScan.create({
    data: {
      tenantId,
      assetName: `${tag} MCP 服务`,
      assetType: 'MCP',
      assetKey: aiAssetKey,
      sourceType: 'UPLOAD',
    },
    select: { id: true },
  });
  await prismaUnscoped.aiComponentFinding.createMany({
    data: [
      { severity: 'HIGH' as const, reviewStatus: 'PENDING' },
      { severity: 'MEDIUM' as const, reviewStatus: 'FALSE_POSITIVE' },
    ].map((f, i) => ({
      tenantId,
      scanId: aiScan.id,
      ruleId: `MCP_RULE_${i}`,
      severity: f.severity,
      riskCategory: '工具投毒',
      title: `组件发现 ${i + 1}`,
      description: '夹具',
      remediation: '移除可疑工具描述',
      confidence: 0.9,
      fingerprint: `fp-${i}`,
      reviewStatus: f.reviewStatus,
    })),
  });

  const discovery = async (createdAt: Date, models: string[]) => {
    const row = await prismaUnscoped.assetDiscoveryRun.create({
      data: {
        tenantId,
        status: 'COMPLETED',
        targets: ['10.98.7.6'],
        ports: [11434],
        hostCount: 1,
        portCount: 1,
        hitCount: 1,
        createdAt,
        hits: {
          create: {
            host: '10.98.7.6',
            port: 11434,
            baseUrl: RISK_FIXTURE_SERVICE,
            serviceType: 'ollama',
            models,
            evidence: '/api/tags',
          },
        },
      },
      select: { id: true },
    });
    return row.id;
  };
  const now = Date.now();
  const firstRun = await discovery(new Date(now - 60_000), [RISK_FIXTURE_UNREGISTERED_MODEL]);
  const secondRun = await discovery(new Date(now - 1_000), [
    RISK_FIXTURE_UNREGISTERED_MODEL,
    RISK_FIXTURE_REGISTERED_MODEL,
  ]);

  return {
    tenantId,
    targets,
    tasks,
    modelFileScanId: modelFileScan.id,
    corpusScanId: corpusScan.id,
    serviceRunId: run.id,
    aiScanId: aiScan.id,
    aiAssetKey,
    discoveryRunIds: [firstRun, secondRun],
  };
}

/** 新建一个测试租户（名字要以调用方的清理前缀开头）。 */
export async function createRiskTenant(name: string): Promise<string> {
  const row = await prismaUnscoped.tenant.create({
    data: { name, code: `p2bf-${randomUUID().slice(0, 8)}` },
    select: { id: true },
  });
  return row.id;
}

/** 在租户里建一个带指定角色的用户，返回可直接用的令牌。 */
export async function riskUserToken(
  app: FastifyInstance,
  tenantId: string,
  username: string,
  roleName: string,
): Promise<string> {
  const role = await prismaUnscoped.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await prismaUnscoped.user.create({
    data: {
      tenantId,
      username,
      passwordHash: 'test-only',
      displayName: username,
      roles: { create: { roleId: role.id } },
    },
  });
  return app.jwt.sign({ sub: user.id, username: user.username });
}

/** 删掉夹具租户里的数据、用户和租户本身。 */
export async function cleanupDetectRiskTenants(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  const where = { tenantId: { in: tenantIds } };
  // 画像（F-5）夹具：组合任务、台账、终端。
  await prismaUnscoped.detectJob.deleteMany({ where });
  await prismaUnscoped.ledgerAsset.deleteMany({ where });
  await prismaUnscoped.fleetEndpoint.deleteMany({ where });
  const runs = await prismaUnscoped.serviceAssuranceRun.findMany({ where, select: { id: true } });
  const runIds = runs.map((r) => r.id);
  await prismaUnscoped.vulnerabilityAssessment.deleteMany({ where: { runId: { in: runIds } } });
  await prismaUnscoped.serviceComponent.deleteMany({ where: { runId: { in: runIds } } });
  await prismaUnscoped.serviceAssuranceRun.deleteMany({ where: { id: { in: runIds } } });
  await prismaUnscoped.assetDiscoveryRun.deleteMany({ where });
  await prismaUnscoped.aiComponentScan.deleteMany({ where });
  await prismaUnscoped.corpusScan.deleteMany({ where });
  await prismaUnscoped.modelFileScan.deleteMany({ where });
  await prismaUnscoped.evalTask.deleteMany({ where });
  await prismaUnscoped.modelTarget.deleteMany({ where });
  await prismaUnscoped.auditLog.deleteMany({ where });
  await prismaUnscoped.user.deleteMany({ where });
  await prismaUnscoped.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}
