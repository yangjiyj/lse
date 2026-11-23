import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TENANT_ADMIN_ROLE } from '@lse/shared';
import { buildApp } from '../src/app.js';
import { prisma, prismaUnscoped } from '../src/db.js';
import { ENDPOINT_ENGINE } from '../src/modules/endpoint-evals/service.js';
import { FLEET_TARGET_PROVIDER } from '../src/modules/fleet-admin/service.js';
import { playbookForDomain } from '../src/modules/reports/remediation-playbook.js';
import { riskDomainForCategory } from '../src/modules/reports/labels.js';
import { parseLedgerGpu } from '../src/modules/detect-risks/profile.js';
import {
  cleanupDetectRiskTenants,
  createRiskTenant,
  riskUserToken,
} from './helpers/detect-risk-fixtures.js';

// F-5 受测应用安全画像（2.5.6）：GET /api/app-profiles、/api/app-profiles/:assetId。

const P = 'F线应用画像';
const U = '__p2bf_profile_';
const SERVER_IP = '10.98.6.5';
const PLATFORM_URL = 'https://agent.p2bf.test';
const ASSET_KEY = 'mcp:p2bf-profile-server';
const MODEL_ASSET_KEY = 'vector:p2bf-profile-db';

let app: Awaited<ReturnType<typeof buildApp>>;
let tenantA = '';
let tenantB = '';
const tokens = {
  tenantAdmin: '',
  noCorpus: '',
  noLedger: '',
  ledgerOnly: '',
  ledgerEval: '',
  otherTenant: '',
  platform: '',
};
const ids = {
  platform: '',
  subPlatform: '',
  model: '',
  server: '',
  component: '',
  modelTask: '',
  wide: '',
  bPlatform: '',
  modelComponent: '',
  modelEndpoint: '',
  shared: '',
  sharedTarget: '',
  sharedTask: '',
  bSharedTask: '',
};

interface Profile {
  asset: {
    id: string;
    name: string;
    attrs: Record<string, unknown>;
    modelTarget: { id: string } | null;
  };
  environment: {
    servers: Array<{
      assetId: string;
      type: string;
      ip: string | null;
      os: string | null;
      cpu: string | null;
      memoryMB: number | null;
      gpu: string | null;
      endpoint: { id: string; hostname: string } | null;
      hardware: { accelerators: unknown[] | null } | null;
    }>;
    software: unknown[];
    components: Array<{ assetId: string; componentType: string | null }>;
    frameworks: Array<{ id: string; name: string }>;
  };
  compute: {
    accelerators: Array<{ vendor: string; memoryMB?: number; serverName: string }>;
    cardCount: number;
    totalMemoryMB: number | null;
  };
  models: Array<{
    assetId: string;
    identity: { verdictLabel: string; knownModel: string | null } | null;
    baseModel: string | null;
    lastEval: { taskId: string } | null;
  }>;
  risks: {
    stats: {
      categories: Array<{
        category: string;
        sources: Array<{ source: string; count: { total: number } | null }>;
      }>;
    };
    top: Array<{ source: string; severity: string }>;
  };
  suggestions: Array<{
    category: string;
    source: string;
    title: string;
    action: string;
    count: number;
  }>;
  truncated: boolean;
}

const bearer = (token: string, headers: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...headers,
});

async function profile(id: string, token = tokens.tenantAdmin, headers?: Record<string, string>) {
  const res = await app.inject({ url: `/api/app-profiles/${id}`, headers: bearer(token, headers) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Profile;
}

const sourceCount = (p: Profile, key: string) =>
  p.risks.stats.categories.flatMap((c) => c.sources).find((s) => s.source === key)!.count;

async function cleanup(): Promise<void> {
  const tenants = await prismaUnscoped.tenant.findMany({
    where: { name: { startsWith: P } },
    select: { id: true },
  });
  await cleanupDetectRiskTenants(tenants.map((t) => t.id));
  // 平台共享的评估对象（夹具里先建在平台租户再改成共享）：按名字删。
  await prismaUnscoped.modelTarget.deleteMany({ where: { name: { startsWith: P } } });
  await prismaUnscoped.user.deleteMany({ where: { username: { startsWith: U } } });
  await prismaUnscoped.role.deleteMany({ where: { name: { startsWith: U } } });
}

async function customRole(name: string, codes: string[]): Promise<string> {
  await prismaUnscoped.role.create({
    data: {
      name,
      permissions: { create: codes.map((code) => ({ permission: { connect: { code } } })) },
    },
  });
  return name;
}

async function asset(
  tenantId: string,
  type: string,
  name: string,
  extra: { attrs?: object; modelTargetId?: string; fleetEndpointId?: string } = {},
) {
  const row = await prismaUnscoped.ledgerAsset.create({
    data: { tenantId, type, name, attrs: extra.attrs ?? {}, ...extra },
    select: { id: true },
  });
  return row.id;
}

async function relate(tenantId: string, fromId: string, kind: string, toId: string) {
  await prismaUnscoped.ledgerRelation.create({ data: { tenantId, fromId, toId, kind } });
}

async function target(tenantId: string, name: string, targetType: 'MODEL' | 'AGENT', model = 'm') {
  const row = await prismaUnscoped.modelTarget.create({
    data: {
      tenantId,
      name,
      provider: 'openai-compatible',
      targetType,
      baseUrl: `${PLATFORM_URL}/v1`,
      apiKey: 'none',
      model,
    },
    select: { id: true },
  });
  return row.id;
}

/** 一台带 2 张 NVIDIA 卡和 vllm 的终端，以及它对应的终端评估对象。 */
async function endpoint(tenantId: string, hostname: string) {
  const e = await prismaUnscoped.fleetEndpoint.create({
    data: {
      tenantId,
      publicId: `p2bf-${randomUUID()}`,
      installationId: randomUUID(),
      machineId: randomUUID(),
      hostname,
      os: 'linux',
      capabilities: [],
      tokenHash: randomUUID(),
      lastSeenAt: new Date(),
    },
  });
  const card = (index: number) => ({
    vendor: 'nvidia',
    model: 'NVIDIA A100 80GB',
    memory_mb: 81920,
    driver_version: '550.54',
    index,
    source: 'nvidia-smi',
  });
  await prismaUnscoped.fleetProbeReport.create({
    data: {
      tenantId,
      endpointId: e.id,
      reportId: randomUUID(),
      scannedAt: new Date(),
      status: 'COMPLETED',
      bodyHash: 'x',
      body: {
        host: {
          os: 'linux',
          accelerators: [card(0), card(1)],
          ai_components: [
            {
              id: 'vllm',
              name: 'vLLM',
              category: 'inference',
              version: '0.6.3',
              source: 'python_package',
            },
          ],
        },
      },
    },
  });
  const fleetTarget = await prismaUnscoped.modelTarget.create({
    data: {
      tenantId,
      name: `${hostname} 终端`,
      provider: FLEET_TARGET_PROVIDER,
      targetType: 'ENDPOINT_AGENT',
      baseUrl: `fleet://${e.publicId}`,
      apiKey: '',
      model: 'endpoint-agent',
      accessConfig: { fleetEndpointId: e.id },
    },
  });
  return { endpointId: e.id, fleetTargetId: fleetTarget.id };
}

async function task(
  tenantId: string,
  modelTargetId: string,
  name: string,
  engines: string[],
  dimensions: string[],
  findings: Array<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>,
) {
  const t = await prismaUnscoped.evalTask.create({
    data: {
      tenantId,
      modelTargetId,
      name,
      engines,
      dimensions,
      status: 'COMPLETED',
      finishedAt: new Date(),
    },
  });
  await prismaUnscoped.finding.createMany({
    data: findings.map((severity, i) => ({
      tenantId,
      taskId: t.id,
      engine: 'rule-judge',
      riskCategory: 'jailbreak',
      severity,
      verdict: 'FAIL' as const,
      title: `[rule-judge] 越狱 ${i + 1}`,
    })),
  });
  return t.id;
}

/** 平台 P：关联智能体评估对象和访问地址；使用模型 M、部署在服务器 S；包含子平台 Q（使用组件 C）。 */
async function seedTenantA(): Promise<void> {
  const t = tenantA;
  const agentTarget = await target(t, `${P}智能体`, 'AGENT');
  const modelTarget = await target(t, `${P}模型`, 'MODEL', 'qwen2-7b');
  const { endpointId, fleetTargetId } = await endpoint(t, 'gpu-node-01');
  ids.platform = await asset(t, 'platform', '客服智能体平台', {
    attrs: { url: PLATFORM_URL },
    modelTargetId: agentTarget,
  });
  // 台账里也填了基座模型和服务器规格：探针、模型文件扫描有数据时以它们为准，没有时用台账兜底。
  ids.model = await asset(t, 'model', '客服模型', {
    modelTargetId: modelTarget,
    attrs: { baseModel: 'Qwen2-7B（台账）' },
  });
  ids.server = await asset(t, 'server', '推理服务器', {
    attrs: {
      ip: SERVER_IP,
      os: 'CentOS 7.9',
      cpu: 'Intel Xeon 8358',
      memoryGB: 512,
      gpu: 'NVIDIA A100 80GB × 4',
    },
    fleetEndpointId: endpointId,
  });
  ids.subPlatform = await asset(t, 'platform', '知识库子平台');
  ids.component = await asset(t, 'component', 'MCP 服务', {
    attrs: { componentType: 'mcp', version: '1.2.0', assetKey: ASSET_KEY },
  });
  await relate(t, ids.platform, 'uses', ids.model);
  await relate(t, ids.platform, 'deployed_on', ids.server);
  await relate(t, ids.model, 'deployed_on', ids.server);
  await relate(t, ids.platform, 'contains', ids.subPlatform);
  await relate(t, ids.subPlatform, 'uses', ids.component);
  // 模型 M 使用组件 C2，C2 部署在终端 E2 上（第二跳）。
  ids.modelComponent = await asset(t, 'component', '向量库', {
    attrs: { componentType: 'vector_db', assetKey: MODEL_ASSET_KEY },
  });
  ids.modelEndpoint = await asset(t, 'endpoint', '开发终端', { attrs: { ip: '10.98.6.9' } });
  await relate(t, ids.model, 'uses', ids.modelComponent);
  await relate(t, ids.modelComponent, 'deployed_on', ids.modelEndpoint);

  // 模型：一次带识别结果的模型文件扫描，一个完成的评估任务带 2 条风险项（内容类）。
  await prismaUnscoped.modelFileScan.create({
    data: {
      tenantId: t,
      source: 'DIRECTORY',
      path: '/models/qwen2',
      targetId: modelTarget,
      status: 'COMPLETED',
      files: [
        { path: '/models/qwen2/config.json', format: 'config', bytes: 10, sha256: 'a' },
        {
          path: '/models/qwen2/model.safetensors',
          format: 'safetensors',
          bytes: 100,
          sha256: 'b',
          meta: {
            identification: {
              verdict: 'original',
              verdictLabel: '原始（官方指令版）',
              name: 'Qwen2-7B-Instruct',
              quantization: 'BF16',
              baseModel: 'Qwen/Qwen2-7B',
              basis: [],
            },
            knownModelLabel: 'Qwen/Qwen2-7B-Instruct',
          },
        },
      ],
    },
  });
  ids.modelTask = await task(t, modelTarget, `${P}模型评估`, [], [], ['CRITICAL', 'MEDIUM']);
  // 服务器关联的终端：终端体检 1 条不通过（应用与环境）。
  await task(t, fleetTargetId, `${P}终端体检`, [ENDPOINT_ENGINE], ['agent_tool_call'], ['HIGH']);

  // 子平台 Q 的组件 C：资产键对应一次组件扫描，1 条发现。
  const scan = await prismaUnscoped.aiComponentScan.create({
    data: {
      tenantId: t,
      assetName: 'MCP 服务',
      assetType: 'MCP',
      assetKey: ASSET_KEY,
      sourceType: 'UPLOAD',
    },
  });
  await prismaUnscoped.aiComponentFinding.create({
    data: {
      tenantId: t,
      scanId: scan.id,
      ruleId: 'MCP_TOOL_POISON',
      severity: 'HIGH',
      riskCategory: '工具投毒',
      title: '工具描述含隐藏指令',
      description: '夹具',
      remediation: '移除工具描述里的隐藏指令后重新发布',
      confidence: 0.9,
      fingerprint: 'fp-profile',
    },
  });

  // 组合任务子任务（ledgerAssetId = M）建出的语料扫描，2 条命中。
  const corpus = await prismaUnscoped.corpusScan.create({
    data: {
      tenantId: t,
      fileName: `${P}语料.jsonl`,
      storageKey: `p2bf-profile-${randomUUID()}`,
      bytes: BigInt(0),
      sha256: '0'.repeat(64),
      status: 'COMPLETED',
    },
  });
  await prismaUnscoped.corpusFinding.createMany({
    data: [1, 2].map((i) => ({
      tenantId: t,
      scanId: corpus.id,
      recordIndex: i,
      line: i,
      fieldPath: 'output',
      category: 'sensitive',
      subtype: 'phone',
      matchText: '13800000000',
      severity: 'MEDIUM',
    })),
  });
  const job = await prismaUnscoped.detectJob.create({
    data: { tenantId: t, name: `${P}组合任务` },
  });
  await prismaUnscoped.detectJobItem.create({
    data: {
      tenantId: t,
      jobId: job.id,
      position: 0,
      kind: 'corpus_scan',
      title: '语料重扫',
      params: {},
      ledgerAssetId: ids.model,
      status: 'COMPLETED',
      recordKind: 'corpus_scan',
      recordId: corpus.id,
    },
  });

  // C2 的组件扫描：1 条中危，规则没写处置（处置建议显示「—」）。
  const modelScan = await prismaUnscoped.aiComponentScan.create({
    data: {
      tenantId: t,
      assetName: '向量库',
      assetType: 'MCP',
      assetKey: MODEL_ASSET_KEY,
      sourceType: 'UPLOAD',
    },
  });
  await prismaUnscoped.aiComponentFinding.create({
    data: {
      tenantId: t,
      scanId: modelScan.id,
      ruleId: 'VECTOR_OPEN',
      severity: 'MEDIUM',
      riskCategory: '访问控制',
      title: '向量库未开启鉴权',
      description: '夹具',
      remediation: '',
      confidence: 0.8,
      fingerprint: 'fp-vector',
    },
  });

  // 服务核验：目标在平台地址下的算进来；前缀相同但不是同一个 origin 的不算。
  const services: Array<[string, string | null]> = [
    [`${PLATFORM_URL}/chat`, `${PLATFORM_URL}/chat`],
    ['https://agent.p2bf.test.evil.example/chat', null],
  ];
  for (const [targetName, normalizedTarget] of services) {
    const run = await prismaUnscoped.serviceAssuranceRun.create({
      data: {
        tenantId: t,
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName,
        normalizedTarget,
        scopePolicyRef: 'profile',
        status: 'COMPLETED',
        requestBudget: {},
      },
    });
    await prismaUnscoped.vulnerabilityAssessment.create({
      data: {
        tenantId: t,
        runId: run.id,
        advisoryId: 'CVE-2026-2001',
        impactStatus: 'AFFECTED',
        evidenceLevel: 'VERSION_MATCH',
        severity: 'MEDIUM',
        title: `服务漏洞 ${targetName}`,
        reason: '夹具',
        assessmentKey: 'k',
      },
    });
  }

  // 平台共享的评估对象：甲的模型资产关联它，乙租户后来也用它做了评估和模型文件扫描（乙的在 seedTenantB 里）。
  // 插入时触发器会把空租户填成平台租户，所以先建再改成共享。
  ids.sharedTarget = (
    await prismaUnscoped.modelTarget.create({
      data: {
        name: `${P}共享模型`,
        provider: 'openai-compatible',
        targetType: 'MODEL',
        baseUrl: 'https://shared.p2bf.test/v1',
        apiKey: 'none',
        model: 'shared',
      },
      select: { id: true },
    })
  ).id;
  await prismaUnscoped.modelTarget.update({
    where: { id: ids.sharedTarget },
    data: { tenantId: null },
  });
  ids.shared = await asset(t, 'platform', '共享模型平台');
  const sharedModel = await asset(t, 'model', '共享模型', { modelTargetId: ids.sharedTarget });
  await relate(t, ids.shared, 'uses', sharedModel);
  ids.sharedTask = await task(t, ids.sharedTarget, `${P}甲共享评估`, [], [], []);
  await prismaUnscoped.evalTask.update({
    where: { id: ids.sharedTask },
    data: { finishedAt: new Date(Date.now() - 86400_000) },
  });

  // 不在子树里的数据：同租户另一个模型的评估任务，不能算进画像。
  const stray = await target(t, `${P}无关模型`, 'MODEL', 'other');
  await task(t, stray, `${P}无关评估`, [], [], ['HIGH', 'HIGH', 'HIGH']);

  // 子树超过 200 个资产的平台：201 个通用软件。
  ids.wide = await asset(t, 'platform', '大平台');
  await prismaUnscoped.ledgerAsset.createMany({
    data: Array.from({ length: 201 }, (_, i) => ({
      tenantId: t,
      type: 'software',
      name: `软件 ${i}`,
      attrs: { vendor: '厂商', version: `1.${i}` },
    })),
  });
  const software = await prismaUnscoped.ledgerAsset.findMany({
    where: { tenantId: t, type: 'software' },
    select: { id: true },
  });
  await prismaUnscoped.ledgerRelation.createMany({
    data: software.map((s) => ({ tenantId: t, fromId: ids.wide, toId: s.id, kind: 'uses' })),
  });
}

/** 另一个租户：同样的服务器 IP、组件资产键和平台地址，全部租户视角下也不能串进来。 */
async function seedTenantB(): Promise<void> {
  const t = tenantB;
  ids.bPlatform = await asset(t, 'platform', '乙租户平台', { attrs: { url: PLATFORM_URL } });
  ids.bSharedTask = await task(t, ids.sharedTarget, `${P}乙共享评估`, [], [], []);
  await prismaUnscoped.modelFileScan.create({
    data: {
      tenantId: t,
      source: 'DIRECTORY',
      path: '/models/b',
      targetId: ids.sharedTarget,
      status: 'COMPLETED',
      files: [
        {
          path: '/models/b/model.safetensors',
          format: 'safetensors',
          bytes: 1,
          sha256: 'b',
          meta: { identification: { verdictLabel: '乙租户的识别结论' } },
        },
      ],
    },
  });
  const scan = await prismaUnscoped.aiComponentScan.create({
    data: {
      tenantId: t,
      assetName: '乙 MCP',
      assetType: 'MCP',
      assetKey: ASSET_KEY,
      sourceType: 'UPLOAD',
    },
  });
  await prismaUnscoped.aiComponentFinding.create({
    data: {
      tenantId: t,
      scanId: scan.id,
      ruleId: 'MCP_TOOL_POISON',
      severity: 'HIGH',
      riskCategory: '工具投毒',
      title: '乙租户的发现',
      description: '夹具',
      remediation: '无',
      confidence: 0.9,
      fingerprint: 'fp-b',
    },
  });
  await prismaUnscoped.assetDiscoveryRun.create({
    data: {
      tenantId: t,
      status: 'COMPLETED',
      targets: [SERVER_IP],
      ports: [8000],
      hostCount: 1,
      portCount: 1,
      hits: {
        create: {
          host: SERVER_IP,
          port: 8000,
          baseUrl: `http://${SERVER_IP}:8000`,
          serviceType: 'vllm',
          models: ['乙租户模型'],
          evidence: '/v1/models',
        },
      },
    },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await cleanup();
  tenantA = await createRiskTenant(`${P}A`);
  tenantB = await createRiskTenant(`${P}B`);
  await seedTenantA();
  await seedTenantB();
  tokens.tenantAdmin = await riskUserToken(app, tenantA, `${U}tadmin`, TENANT_ADMIN_ROLE);
  tokens.otherTenant = await riskUserToken(app, tenantB, `${U}btadmin`, TENANT_ADMIN_ROLE);
  tokens.noCorpus = await riskUserToken(
    app,
    tenantA,
    `${U}nocorpus`,
    await customRole(`${U}nocorpus`, ['ledger:read', 'eval_task:read', 'engine:scan']),
  );
  tokens.noLedger = await riskUserToken(
    app,
    tenantA,
    `${U}noledger`,
    await customRole(`${U}noledger`, ['eval_task:read', 'corpus_scan:read']),
  );
  tokens.ledgerOnly = await riskUserToken(
    app,
    tenantA,
    `${U}ledgeronly`,
    await customRole(`${U}ledgeronly`, ['ledger:read']),
  );
  tokens.ledgerEval = await riskUserToken(
    app,
    tenantA,
    `${U}ledgereval`,
    await customRole(`${U}ledgereval`, ['ledger:read', 'eval_task:read']),
  );
  const admin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: ['Admin', '@', '12345'].join('') },
  });
  assert.equal(admin.statusCode, 200, admin.body);
  tokens.platform = admin.json().token;
});

after(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

test('环境与算力：服务器去重、带硬件，框架合并，算力卡合计', async () => {
  const p = await profile(ids.platform);
  assert.equal(p.asset.id, ids.platform);
  assert.equal(p.asset.attrs.url, PLATFORM_URL);
  assert.ok(p.asset.modelTarget);
  assert.equal(
    p.environment.servers.filter((s) => s.assetId === ids.server).length,
    1,
    'P 和 M 都部署在 S 上，只算一次',
  );
  const server = p.environment.servers.find((s) => s.assetId === ids.server)!;
  assert.equal(server.assetId, ids.server);
  assert.equal(server.ip, SERVER_IP);
  assert.equal(server.endpoint?.hostname, 'gpu-node-01');
  assert.equal(server.hardware?.accelerators?.length, 2);
  assert.deepEqual(
    p.environment.frameworks.map((f) => f.id),
    ['vllm'],
  );
  assert.deepEqual(
    p.environment.components.map((c) => [c.assetId, c.componentType]),
    [
      [ids.component, 'mcp'],
      [ids.modelComponent, 'vector_db'],
    ],
  );
  assert.equal(p.compute.cardCount, 2);
  assert.equal(p.compute.totalMemoryMB, 163840);
  assert.equal(p.compute.accelerators[0]!.serverName, '推理服务器');
  assert.equal(p.truncated, false);
});

test('模型：识别结论取最近一次完成的模型文件扫描，最近评估取最近一次完成的任务', async () => {
  const p = await profile(ids.platform);
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0]!.assetId, ids.model);
  assert.equal(p.models[0]!.identity?.verdictLabel, '原始（官方指令版）');
  assert.equal(p.models[0]!.identity?.knownModel, 'Qwen/Qwen2-7B-Instruct');
  assert.equal(p.models[0]!.lastEval?.taskId, ids.modelTask);
});

test('风险：经评估对象、终端、子平台组件、组合任务子任务关联，子树外的不算', async () => {
  const p = await profile(ids.platform);
  assert.equal(sourceCount(p, 'eval_content')?.total, 2, '模型的评估任务');
  assert.equal(sourceCount(p, 'eval_app')?.total, 1, '服务器关联终端的体检');
  assert.equal(sourceCount(p, 'corpus')?.total, 2, '经组合任务子任务关联');
  assert.equal(sourceCount(p, 'ai_component')?.total, 2, '子平台 Q 的组件、模型使用的组件各 1');
  assert.equal(sourceCount(p, 'service_assurance')?.total, 1, '平台地址下的服务核验');
  assert.equal(sourceCount(p, 'asset_discovery')?.total, 0, '另一个租户的测绘不算');
  assert.ok(p.risks.top.length > 0 && p.risks.top.length <= 10);
  assert.equal(p.risks.top[0]!.severity, 'CRITICAL');
});

test('处置建议：内容类按风险域给处置手册的第一步，语料、组件各一条', async () => {
  const p = await profile(ids.platform);
  const domain = riskDomainForCategory('jailbreak', '[rule-judge] 越狱 1');
  const content = p.suggestions.find((s) => s.source === 'eval_content');
  assert.ok(content, '有内容类建议');
  assert.equal(content.category, 'content');
  assert.equal(content.count, 2);
  assert.ok(content.action.startsWith(playbookForDomain(domain).steps.immediate[0]!));
  const corpus = p.suggestions.find((s) => s.source === 'corpus');
  assert.equal(corpus?.title, '敏感信息');
  assert.equal(corpus?.count, 2);
  const component = p.suggestions.find((s) => s.source === 'ai_component');
  assert.equal(component?.action, '移除工具描述里的隐藏指令后重新发布');
  assert.ok(p.suggestions.length <= 10);
});

test('只有应用平台有画像；另一个租户 404；没有台账权限 403', async () => {
  const res = await app.inject({
    url: `/api/app-profiles/${ids.model}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'PROFILE_PLATFORM_ONLY');
  const other = await app.inject({
    url: `/api/app-profiles/${ids.platform}`,
    headers: bearer(tokens.otherTenant),
  });
  assert.equal(other.statusCode, 404);
  const missing = await app.inject({
    url: `/api/app-profiles/${randomUUID()}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.equal(missing.statusCode, 404);
  const denied = await app.inject({
    url: `/api/app-profiles/${ids.platform}`,
    headers: bearer(tokens.noLedger),
  });
  assert.equal(denied.statusCode, 403);
});

test('没有语料扫描权限：语料来源为 null，主要风险和处置建议里也没有语料', async () => {
  const p = await profile(ids.platform, tokens.noCorpus);
  assert.equal(sourceCount(p, 'corpus'), null);
  assert.ok(p.risks.top.every((r) => r.source !== 'corpus'));
  assert.ok(p.suggestions.every((s) => s.source !== 'corpus'));
  assert.equal(sourceCount(p, 'eval_content')?.total, 2);
});

test('子树超过 200 个资产时截断并标记', async () => {
  const p = await profile(ids.wide);
  assert.equal(p.truncated, true);
  const q = await profile(ids.subPlatform);
  assert.equal(q.truncated, false);
});

test('全部租户视角能看画像，风险只算该平台所属租户的', async () => {
  const p = await profile(ids.platform, tokens.platform, { 'x-lse-tenant': 'all' });
  assert.equal(sourceCount(p, 'ai_component')?.total, 2, '乙租户同资产键的发现不算');
  assert.equal(sourceCount(p, 'asset_discovery')?.total, 0, '乙租户同 IP 的测绘不算');
  assert.equal(sourceCount(p, 'eval_content')?.total, 2);
});

test('应用平台列表：只列平台，带风险数；只看本租户', async () => {
  const res = await app.inject({ url: '/api/app-profiles', headers: bearer(tokens.tenantAdmin) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    items: Array<{
      id: string;
      name: string;
      assetCount: number;
      riskTotal: number | null;
      riskHigh: number | null;
    }>;
    total: number;
  };
  assert.deepEqual(
    body.items.map((i) => i.id).sort(),
    [ids.platform, ids.subPlatform, ids.wide, ids.shared].sort(),
  );
  assert.equal(body.total, 4);
  const platform = body.items.find((i) => i.id === ids.platform)!;
  assert.equal(platform.riskTotal, 2 + 1 + 2 + 2 + 1, '内容 2、终端 1、语料 2、组件 2、服务核验 1');
  assert.equal(platform.riskHigh, 3, '严重 1、终端高危 1、组件高危 1');
  assert.equal(platform.assetCount, 6, 'Q、M、S、C、C2、E2，不算平台自己');
  const search = await app.inject({
    url: `/api/app-profiles?q=${encodeURIComponent('客服')}`,
    headers: bearer(tokens.tenantAdmin),
  });
  assert.deepEqual(
    search.json().items.map((i: { id: string }) => i.id),
    [ids.platform],
  );
  const denied = await app.inject({ url: '/api/app-profiles', headers: bearer(tokens.noLedger) });
  assert.equal(denied.statusCode, 403);
});

test('子树走模型「使用」的组件，以及这些组件部署的终端', async () => {
  const p = await profile(ids.platform);
  assert.ok(p.environment.components.some((c) => c.assetId === ids.modelComponent));
  const endpoint = p.environment.servers.find((s) => s.assetId === ids.modelEndpoint);
  assert.equal(endpoint?.type, 'endpoint');
  assert.equal(endpoint?.ip, '10.98.6.9');
  assert.equal(endpoint?.hardware, null);
});

test('服务核验按平台地址的 origin 匹配，前缀相同的别的域名不算；处置为空的建议照样列出', async () => {
  const p = await profile(ids.platform);
  assert.equal(sourceCount(p, 'service_assurance')?.total, 1);
  const titles = p.suggestions.filter((s) => s.source === 'service_assurance').map((s) => s.title);
  assert.deepEqual(titles, [`服务漏洞 ${PLATFORM_URL}/chat`]);
  const empty = p.suggestions.find((s) => s.title === '向量库未开启鉴权');
  assert.equal(empty?.action, '');
});

test('各块按对应模块的读权限过滤：只有台账权限时识别结论、最近评估、终端硬件都不给', async () => {
  const p = await profile(ids.platform, tokens.ledgerOnly);
  assert.equal(p.models[0]!.identity, null);
  assert.equal(p.models[0]!.lastEval, null);
  assert.ok(p.environment.servers.every((s) => s.hardware === null));
  assert.deepEqual(p.environment.frameworks, []);
  // 看不到探针数据时，服务器规格和算力卡用台账里填的兜底。
  assert.equal(p.compute.cardCount, 4);
  assert.equal(p.compute.totalMemoryMB, 4 * 81920);
  assert.equal(p.models[0]!.baseModel, 'Qwen2-7B（台账）');
  assert.ok(p.risks.stats.categories.every((c) => c.sources.every((s) => s.count === null)));
  assert.deepEqual(p.risks.top, []);
  assert.deepEqual(p.suggestions, []);
  const withEval = await profile(ids.platform, tokens.ledgerEval);
  assert.equal(
    withEval.models[0]!.lastEval?.taskId,
    ids.modelTask,
    '有 eval_task:read 看得到最近评估',
  );
  assert.equal(withEval.models[0]!.identity, null, '没有模型文件扫描的读权限');
});

test('全部租户视角：平台共享的评估对象被别的租户用过，识别结论和最近评估仍只取平台所属租户的', async () => {
  const own = await profile(ids.shared);
  assert.equal(own.models[0]!.lastEval?.taskId, ids.sharedTask);
  assert.equal(own.models[0]!.identity, null);
  const all = await profile(ids.shared, tokens.platform, { 'x-lse-tenant': 'all' });
  assert.equal(all.models[0]!.lastEval?.taskId, ids.sharedTask, '不取乙租户更新的评估');
  assert.equal(all.models[0]!.identity, null, '不取乙租户的识别结论');
});

test('测绘有范围时按范围预筛：较新的无关测绘不挤掉命中服务器 IP 的那次，也不标截断', async () => {
  const marker = '10.98.10.0/24';
  const hit = await prismaUnscoped.assetDiscoveryRun.create({
    data: {
      tenantId: tenantA,
      status: 'COMPLETED',
      targets: [marker],
      ports: [8000],
      hostCount: 1,
      portCount: 1,
      createdAt: new Date(Date.now() - 3600_000),
      hits: {
        create: {
          host: SERVER_IP,
          port: 8000,
          baseUrl: `http://${SERVER_IP}:8000`,
          serviceType: 'vllm',
          models: ['未登记模型'],
          evidence: '/v1/models',
        },
      },
    },
  });
  await prismaUnscoped.assetDiscoveryRun.createMany({
    data: Array.from({ length: 500 }, () => ({
      tenantId: tenantA,
      status: 'COMPLETED',
      targets: [marker],
      ports: [8000],
      hostCount: 1,
      portCount: 1,
    })),
  });
  try {
    const p = await profile(ids.platform);
    assert.equal(sourceCount(p, 'asset_discovery')?.total, 1);
    const stats = p.risks.stats as unknown as { discoveryRunsTruncated: boolean };
    assert.equal(stats.discoveryRunsTruncated, false);
    assert.ok(hit.id);
  } finally {
    await prismaUnscoped.assetDiscoveryRun.deleteMany({
      where: { tenantId: tenantA, targets: { has: marker } },
    });
  }
});

test('检测结果按画像范围：?profile= 的计数和明细与画像一致，带回平台；权限和租户', async () => {
  const p = await profile(ids.platform);
  const get = (url: string, token = tokens.tenantAdmin) =>
    app.inject({ url, headers: bearer(token) });
  const global = await get('/api/detect-results?category=content&source=eval_content');
  assert.equal(global.json().total, 5, '全租户口径含子树外的 3 条');
  for (const category of p.risks.stats.categories) {
    for (const source of category.sources) {
      if (!source.count) continue;
      const res = await get(
        `/api/detect-results?category=${category.category}&source=${source.source}&pageSize=100&profile=${ids.platform}`,
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().total, source.count.total, source.source);
      assert.equal(res.json().items.length, source.count.total, source.source);
      assert.deepEqual(res.json().profile, { id: ids.platform, name: '客服智能体平台' });
    }
  }
  const stats = await get(`/api/detect-results/stats?profile=${ids.platform}`);
  assert.equal(stats.statusCode, 200, stats.body);
  assert.deepEqual(stats.json().categories, p.risks.stats.categories);
  assert.deepEqual(stats.json().profile, { id: ids.platform, name: '客服智能体平台' });
  const plain = await get('/api/detect-results/stats');
  assert.equal(plain.json().profile, null);

  const url = (id: string) => `/api/detect-results?category=content&profile=${id}`;
  assert.equal((await get(url(ids.platform), tokens.otherTenant)).statusCode, 404);
  const notPlatform = await get(url(ids.model));
  assert.equal(notPlatform.statusCode, 400);
  assert.equal(notPlatform.json().error.code, 'PROFILE_PLATFORM_ONLY');
  assert.equal((await get(url(ids.platform), tokens.noLedger)).statusCode, 403, '要 ledger:read');
  assert.equal(
    (await get(`/api/detect-results/stats?profile=${ids.platform}`, tokens.noLedger)).statusCode,
    403,
  );
  assert.equal((await get(url('not-a-uuid'))).statusCode, 400);
  const all = await app.inject({
    url: `/api/detect-results?category=content&source=eval_content&profile=${ids.platform}&tenantId=${tenantB}`,
    headers: bearer(tokens.platform, { 'x-lse-tenant': 'all' }),
  });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().total, 2, '带画像时按平台所属租户算，忽略租户筛选');
});

test('服务器规格：探针上报的优先，探针没有的项用台账里填的兜底；算力卡同样', async () => {
  const probe = await profile(ids.platform);
  const server = probe.environment.servers.find((s) => s.assetId === ids.server)!;
  assert.equal(server.os, 'linux', '探针上报了系统，不用台账的 CentOS');
  assert.equal(server.cpu, 'Intel Xeon 8358', '探针没报 CPU，用台账的');
  assert.equal(server.memoryMB, 512 * 1024, '探针没报内存，用台账的');
  assert.equal(server.gpu, 'NVIDIA A100 80GB × 2', '探针报了 2 张卡');
  assert.equal(probe.compute.cardCount, 2, '探针报了卡就不再加台账的 4 张');

  const ledger = await profile(ids.platform, tokens.ledgerOnly);
  const fallback = ledger.environment.servers.find((s) => s.assetId === ids.server)!;
  assert.deepEqual(
    [fallback.os, fallback.cpu, fallback.memoryMB, fallback.gpu],
    ['CentOS 7.9', 'Intel Xeon 8358', 512 * 1024, 'NVIDIA A100 80GB × 4'],
  );
  assert.equal(ledger.compute.cardCount, 4);
  const card = ledger.compute.accelerators[0]!;
  assert.equal(card.vendor, 'nvidia');
  assert.equal(card.model, 'NVIDIA A100 80GB');
  assert.equal(card.memoryMB, 81920);
  assert.equal(card.serverName, '推理服务器');
  const endpoint = ledger.environment.servers.find((s) => s.assetId === ids.modelEndpoint)!;
  assert.deepEqual(
    [endpoint.os, endpoint.cpu, endpoint.memoryMB, endpoint.gpu],
    [null, null, null, null],
  );
});

test('模型基座：模型文件扫描的识别结论优先，没有时用台账里填的', async () => {
  const p = await profile(ids.platform);
  assert.equal(p.models[0]!.baseModel, 'Qwen/Qwen2-7B', '扫描识别出的');
  const ledger = await profile(ids.platform, tokens.ledgerOnly);
  assert.equal(ledger.models[0]!.identity, null);
  assert.equal(ledger.models[0]!.baseModel, 'Qwen2-7B（台账）', '看不到扫描时用台账的');
});

test('台账 GPU 文字解析：型号、数量、单卡显存、厂商', () => {
  const cards = (text: string) =>
    parseLedgerGpu(text).map((c) => [c.vendor, c.model, c.memoryMB ?? null]);
  assert.deepEqual(cards('NVIDIA A100 80GB × 2'), [
    ['nvidia', 'NVIDIA A100 80GB', 81920],
    ['nvidia', 'NVIDIA A100 80GB', 81920],
  ]);
  assert.equal(parseLedgerGpu('8x H800 80G').length, 8);
  assert.equal(parseLedgerGpu('8x H800 80G')[0]!.model, 'H800 80G');
  assert.deepEqual(cards('昇腾 910B 64GB 2卡'), [
    ['huawei', '昇腾 910B 64GB', 65536],
    ['huawei', '昇腾 910B 64GB', 65536],
  ]);
  assert.deepEqual(cards('RTX 4090；T4 16GB'), [
    ['nvidia', 'RTX 4090', null],
    ['nvidia', 'T4 16GB', 16384],
  ]);
  assert.deepEqual(cards('自研加速卡'), [['other', '自研加速卡', null]]);
  assert.deepEqual(parseLedgerGpu('  '), []);
  assert.equal(parseLedgerGpu('A100 × 999').length, 64, '单项最多 64 张');
});

test('关联终端与资产同租户时取它的硬件；终端转到别的租户后当没关联，不取', async () => {
  const { endpointId } = await endpoint(tenantA, 'gpu-node-transfer');
  const platform = await asset(tenantA, 'platform', '终端归属核对平台');
  const server = await asset(tenantA, 'server', '归属核对服务器', {
    attrs: { ip: '10.98.6.77' },
    fleetEndpointId: endpointId,
  });
  await relate(tenantA, platform, 'deployed_on', server);
  try {
    const linked = await profile(platform);
    const row = linked.environment.servers.find((s) => s.assetId === server)!;
    assert.equal(row.endpoint?.hostname, 'gpu-node-transfer');
    assert.equal(row.hardware?.accelerators?.length, 2);
    assert.equal(linked.compute.cardCount, 2);
    assert.equal(sourceCount(linked, 'eval_app')?.total, 0);

    // 终端被转到乙租户（台账资产的关联没改）：画像不再取它的硬件和终端评估对象。
    await prismaUnscoped.fleetEndpoint.update({
      where: { id: endpointId },
      data: { tenantId: tenantB },
    });
    const moved = await profile(platform);
    const after = moved.environment.servers.find((s) => s.assetId === server)!;
    assert.equal(after.endpoint, null);
    assert.equal(after.hardware, null);
    assert.equal(moved.compute.cardCount, 0);
  } finally {
    await prismaUnscoped.ledgerAsset.deleteMany({ where: { id: { in: [platform, server] } } });
  }
});
