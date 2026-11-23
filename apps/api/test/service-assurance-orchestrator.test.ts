import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { prisma } from '../src/db.js';
import {
  readExecutionChecks,
  buildExecutionSummary,
} from '../src/modules/service-assurance/execution-evidence.js';
import { ScannerClientError } from '../src/modules/service-assurance/adapters/client.js';
import type {
  NucleiScanRequest,
  NucleiScanResponse,
} from '../src/modules/service-assurance/adapters/nuclei.js';
import type {
  TrivyScanRequest,
  TrivyScanResponse,
} from '../src/modules/service-assurance/adapters/trivy.js';
import type {
  ZapScanRequest,
  ZapScanResponse,
} from '../src/modules/service-assurance/adapters/zap.js';
import {
  executeServiceAssuranceRun,
  type ServiceAssuranceOrchestratorDependencies,
} from '../src/modules/service-assurance/orchestrator.js';
import { parseSbomUpload } from '../src/modules/service-assurance/sbom.js';

const prefix = `__service_assurance_orchestrator_${randomUUID()}_`;
const createdTaskIds: string[] = [];
const createdTargetIds: string[] = [];
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/service-assurance/${name}`, import.meta.url), 'utf8');

function evidenceDigest(parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

function fixedAdvisoryRecord(databaseDigest: string) {
  const value = {
    ecosystem: 'maven',
    packageName: 'org.apache.logging.log4j:log4j-core',
    purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.25.4',
    installedVersion: '2.25.4',
    advisoryId: 'CVE-2021-44228',
    vulnerableVersions: ['>=2.13.0, <2.15.0', '>=2.4, <2.12.2'],
    patchedVersions: ['2.15.0', '2.12.2'],
    unaffectedVersions: [] as string[],
  };
  return {
    ...value,
    recordSha256: evidenceDigest([
      databaseDigest,
      value.ecosystem,
      value.packageName,
      value.purl,
      value.installedVersion,
      value.advisoryId,
      value.vulnerableVersions.join('\n'),
      value.patchedVersions.join('\n'),
      value.unaffectedVersions.join('\n'),
    ]),
  };
}

async function createRun(
  label: string,
  mode: 'SAFE' | 'DEEP' | 'SBOM' = 'SAFE',
  targetKind: 'ENDPOINT' | 'OPENAPI' | 'SBOM' = mode === 'SBOM' ? 'SBOM' : 'ENDPOINT',
) {
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}${label}`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'orchestrator-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
    },
  });
  createdTargetIds.push(target.id);
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}${label}`,
      modelTargetId: target.id,
      engines: [],
      dimensions: [],
    },
  });
  createdTaskIds.push(task.id);
  const run = await prisma.serviceAssuranceRun.create({
    data: {
      taskId: task.id,
      mode,
      targetKind,
      targetName: label,
      normalizedTarget: mode === 'SBOM' ? null : 'https://api.example.test/v1',
      scopePolicyRef: 'customer-lab',
      requestBudget: { maxRequests: 200 },
      authorizationConfirmed: mode === 'DEEP',
      authorizationConfirmedAt: mode === 'DEEP' ? new Date() : null,
      rulesetVersion: mode === 'SBOM' ? null : 'lse-nuclei-safe-2026.08.30',
      rulesetDigest: mode === 'SBOM' ? null : `sha256:${'a'.repeat(64)}`,
      vulnerabilityDbVersion: mode === 'SBOM' ? 'trivy-db-2026.05.22' : null,
      vulnerabilityDbDigest: mode === 'SBOM' ? `sha256:${'c'.repeat(64)}` : null,
      status: 'PENDING',
      coverageStatus: 'NOT_READY',
    },
  });
  return { task, run };
}

after(async () => {
  if (createdTaskIds.length > 0) {
    await prisma.serviceEvidence.deleteMany({ where: { run: { taskId: { in: createdTaskIds } } } });
    await prisma.vulnerabilityAssessment.deleteMany({
      where: { run: { taskId: { in: createdTaskIds } } },
    });
    await prisma.serviceComponent.deleteMany({
      where: { run: { taskId: { in: createdTaskIds } } },
    });
    await prisma.serviceAsset.deleteMany({ where: { run: { taskId: { in: createdTaskIds } } } });
    await prisma.serviceAssuranceRun.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.finding.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.engineRun.deleteMany({ where: { taskId: { in: createdTaskIds } } });
    await prisma.evalTask.deleteMany({ where: { id: { in: createdTaskIds } } });
  }
  if (createdTargetIds.length > 0) {
    await prisma.modelTarget.deleteMany({ where: { id: { in: createdTargetIds } } });
  }
  await prisma.$disconnect();
});

// Observed sidecar fixture: both fixed SAFE HTTP checks sent one request and
// received a complete response. This is independent of the configured plan size.
function safeExecution() {
  return {
    requestCount: 2,
    checks: [
      {
        id: 'lse-http-security-headers',
        label: '响应类型防护头检查',
        status: 'COMPLETED' as const,
        requestCount: 1,
        detail: '已观察到实际请求及完整响应，检查执行完成。',
      },
      {
        id: 'lse-triton-product-fingerprint',
        label: 'Triton 服务识别',
        status: 'COMPLETED' as const,
        requestCount: 1,
        detail: '已观察到实际请求及完整响应，检查执行完成。',
      },
    ],
  };
}

function response(
  outputJsonl: string,
  overrides: Partial<NucleiScanResponse> = {},
): NucleiScanResponse {
  return {
    schemaVersion: 1,
    completed: true,
    outputJsonl,
    execution: safeExecution(),
    durationMs: 25,
    rulesetVersion: 'lse-nuclei-safe-2026.08.30',
    rulesetDigest: `sha256:${'a'.repeat(64)}`,
    rulesetUpdatedAt: '2026-08-30T00:00:00.000Z',
    rulesetStatus: 'CURRENT',
    engineVersion: '3.9.0',
    engineDigest: `sha256:${'b'.repeat(64)}`,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function trivyResponse(
  outputJson: string,
  overrides: Partial<TrivyScanResponse> = {},
): TrivyScanResponse {
  const vulnerabilityDbDigest = `sha256:${'c'.repeat(64)}`;
  return {
    schemaVersion: 1,
    completed: true,
    outputJson,
    durationMs: 30,
    vulnerabilityDbVersion: 'trivy-db-2026.05.22',
    vulnerabilityDbDigest,
    vulnerabilityDbUpdatedAt: '2026-05-22T19:06:39.311Z',
    vulnerabilityDbStatus: 'CURRENT',
    engineVersion: '0.70.0',
    engineDigest: `sha256:${'d'.repeat(64)}`,
    advisoryQueryCompleted: true,
    advisoryRecords: [],
    advisoryRecordsSha256: evidenceDigest([]),
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function zapResponse(
  outputJson: string,
  overrides: Partial<ZapScanResponse> = {},
): ZapScanResponse {
  return {
    schemaVersion: 1,
    completed: true,
    outputJson,
    execution: {
      requestCount: 5,
      checks: [
        {
          id: 'zap-api-passive',
          label: '接口描述与被动响应检查',
          status: 'UNKNOWN',
          requestCount: null,
          detail: '网关观察到五个请求，但无法归属到具体被动规则。',
        },
      ],
    },
    durationMs: 35,
    rulesetVersion: 'lse-nuclei-safe-2026.08.30',
    rulesetDigest: `sha256:${'a'.repeat(64)}`,
    rulesetUpdatedAt: '2026-08-30T00:00:00.000Z',
    rulesetStatus: 'CURRENT',
    engineVersion: '2.16.1',
    engineDigest: `sha256:${'e'.repeat(64)}`,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function dependencies(
  executeNuclei: (request: NucleiScanRequest) => Promise<NucleiScanResponse>,
  overrides: Partial<ServiceAssuranceOrchestratorDependencies> = {},
): ServiceAssuranceOrchestratorDependencies {
  return {
    loadNucleiRuntime: () => ({
      baseUrl: 'http://scanner.internal:8095',
      expectedEngineDigest: `sha256:${'b'.repeat(64)}`,
      ruleset: {
        version: 'lse-nuclei-safe-2026.08.30',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    }),
    resolveScopePolicy: (ref) => {
      assert.equal(ref, 'customer-lab');
      return {
        ref,
        origins: ['https://api.example.test'],
        cidrs: ['93.184.216.0/24'],
        allowPrivate: false,
        allowPublic: true,
      };
    },
    resolveTarget: async (rawUrl, policy) => {
      assert.equal(rawUrl, 'https://api.example.test/v1');
      assert.equal(policy.ref, 'customer-lab');
      return {
        url: new URL(rawUrl),
        hostname: 'api.example.test',
        addresses: ['93.184.216.34'],
        pinnedAddress: '93.184.216.34',
      };
    },
    executeNuclei,
    loadTrivyRuntime: () => ({
      baseUrl: 'http://scanner.internal:8095',
      expectedEngineDigest: `sha256:${'d'.repeat(64)}`,
      vulnerabilityDb: {
        version: 'trivy-db-2026.05.22',
        digest: `sha256:${'c'.repeat(64)}`,
      },
    }),
    executeTrivy: async () => {
      throw new Error('安全检查不应调用组件清单适配器');
    },
    loadZapRuntime: () => ({
      baseUrl: 'http://zap.internal:8097',
      expectedEngineDigest: `sha256:${'e'.repeat(64)}`,
      ruleset: {
        version: 'lse-nuclei-safe-2026.08.30',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    }),
    executeZap: async () => {
      throw new Error('非 OpenAPI 安全检查不应调用 API 适配器');
    },
    takeSbom: async () => {
      throw new Error('安全检查不应读取组件清单通道');
    },
    isCancelRequested: async () => false,
    ...overrides,
  };
}

test('组件清单核验完成查询但对未覆盖组件保留不完整结论', async () => {
  const { task, run } = await createRun('组件清单编排', 'SBOM');
  const original = await fixture('cyclonedx-triton-affected.json');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.properties = [
    {
      name: 'integration-sentinel',
      value: 'SENTINEL_SBOM_SECRET_NEVER_PERSIST',
    },
  ];
  const content = JSON.stringify(document);
  const contentType = 'application/vnd.cyclonedx+json';
  const parsed = parseSbomUpload({ contentType, content });
  const output = await fixture('trivy-affected.json');
  let consumed = 0;
  let request: TrivyScanRequest | null = null;

  await executeServiceAssuranceRun(
    run.id,
    dependencies(
      async () => {
        throw new Error('SBOM 模式不应调用安全检查适配器');
      },
      {
        takeSbom: async (runId) => {
          assert.equal(runId, run.id);
          consumed += 1;
          return { contentType, content, parsed };
        },
        executeTrivy: async (value) => {
          request = value;
          return trivyResponse(output);
        },
      },
    ),
  );

  assert.equal(consumed, 1);
  assert.ok(request);
  assert.equal(request.sbom.contentSha256, parsed.contentSha256);
  assert.match(request.sbom.content, /SENTINEL_SBOM_SECRET_NEVER_PERSIST/);
  assert.deepEqual(request.policy, {
    offline: true,
    skipDbUpdate: true,
    skipJavaDbUpdate: true,
    skipVexRepoUpdate: true,
    disableTelemetry: true,
    detectionPriority: 'precise',
  });

  const storedRun = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  assert.equal(storedRun.status, 'COMPLETED');
  assert.equal(storedRun.coverageStatus, 'INCOMPLETE');
  assert.equal(storedRun.vulnerabilityDbVersion, 'trivy-db-2026.05.22');
  assert.match(storedRun.vulnerabilityDbDigest ?? '', /^sha256:[a-f0-9]{64}$/);

  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-trivy' },
  });
  assert.equal(engineRun.status, 'SUCCESS');
  assert.equal(engineRun.rawOutput, null);
  assert.doesNotMatch(
    JSON.stringify([storedRun, engineRun]),
    /SENTINEL_SBOM_SECRET_NEVER_PERSIST|CycloneDX/,
  );
  const storedEvidence = await prisma.serviceEvidence.findMany({ where: { runId: run.id } });
  const executionChecks = readExecutionChecks(storedEvidence);
  assert.deepEqual(
    executionChecks.map((check) => [check.id, check.status, check.requestCount]).sort(),
    [
      ['sbom-advisories', 'COMPLETED', 0],
      ['sbom-components', 'COMPLETED', 0],
    ],
  );

  const storedAssessments = await prisma.vulnerabilityAssessment.findMany({
    where: { runId: run.id },
  });
  const storedFindings = await prisma.finding.findMany({ where: { taskId: task.id } });
  const affected = storedAssessments.find(
    (assessment) => assessment.advisoryId === 'CVE-2021-44228',
  );
  assert.equal(affected?.impactStatus, 'AFFECTED');
  assert.equal(affected?.evidenceLevel, 'VERSION_MATCH');
  assert.ok(
    storedAssessments.some(
      (assessment) =>
        assessment.impactStatus === 'UNDER_INVESTIGATION' && assessment.evidenceLevel === 'LEAD',
    ),
  );
  assert.equal(storedFindings.length, 1);
  assert.doesNotMatch(
    JSON.stringify([storedEvidence, storedAssessments, storedFindings]),
    /SENTINEL_SBOM_SECRET_NEVER_PERSIST|CycloneDX|outputJson/i,
  );

  await executeServiceAssuranceRun(
    run.id,
    dependencies(async () => response('')),
  );
  assert.equal(consumed, 1);
});

test('组件清单编排将固定库公告证据持久化为具体非受影响判断', async () => {
  const { task, run } = await createRun('组件清单修复版本编排', 'SBOM');
  const content = await fixture('cyclonedx-triton-fixed.json');
  const contentType = 'application/vnd.cyclonedx+json';
  const parsed = parseSbomUpload({ contentType, content });
  const output = await fixture('trivy-fixed.json');
  const databaseDigest = `sha256:${'c'.repeat(64)}`;
  const record = fixedAdvisoryRecord(databaseDigest);

  await executeServiceAssuranceRun(
    run.id,
    dependencies(
      async () => {
        throw new Error('SBOM 模式不应调用安全检查适配器');
      },
      {
        takeSbom: async () => ({ contentType, content, parsed }),
        executeTrivy: async () =>
          trivyResponse(output, {
            advisoryRecords: [record],
            advisoryRecordsSha256: evidenceDigest([record.recordSha256]),
          }),
      },
    ),
  );

  const assessment = await prisma.vulnerabilityAssessment.findFirst({
    where: { runId: run.id, advisoryId: 'CVE-2021-44228' },
  });
  assert.ok(assessment);
  assert.equal(assessment.impactStatus, 'NOT_AFFECTED');
  assert.equal(assessment.evidenceLevel, 'VERSION_MATCH');
  assert.equal(assessment.fixedVersion, '2.12.2, 2.15.0');
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
});

test('漏洞库基线漂移时在消费组件清单和外呼前失败关闭', async () => {
  const { task, run } = await createRun('组件清单基线漂移', 'SBOM');
  let consumed = false;
  let called = false;

  await assert.rejects(
    executeServiceAssuranceRun(
      run.id,
      dependencies(
        async () => {
          throw new Error('组件清单模式不应调用安全检查适配器');
        },
        {
          loadTrivyRuntime: () => ({
            baseUrl: 'http://scanner.internal:8095',
            expectedEngineDigest: `sha256:${'d'.repeat(64)}`,
            vulnerabilityDb: {
              version: 'trivy-db-drifted',
              digest: `sha256:${'e'.repeat(64)}`,
            },
          }),
          takeSbom: async () => {
            consumed = true;
            throw new Error('基线漂移时不应消费组件清单');
          },
          executeTrivy: async () => {
            called = true;
            throw new Error('基线漂移时不应调用 Trivy');
          },
        },
      ),
    ),
    (error: unknown) =>
      error instanceof ScannerClientError &&
      error.code === 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH',
  );

  assert.equal(consumed, false);
  assert.equal(called, false);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.failureCode, 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH');
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
});

test('规则集基线漂移时在目标解析和外呼前失败关闭', async () => {
  const { task, run } = await createRun('规则集基线漂移');
  let resolved = false;
  let called = false;

  await assert.rejects(
    executeServiceAssuranceRun(
      run.id,
      dependencies(
        async () => {
          called = true;
          return response('');
        },
        {
          loadNucleiRuntime: () => ({
            baseUrl: 'http://scanner.internal:8095',
            expectedEngineDigest: `sha256:${'b'.repeat(64)}`,
            ruleset: {
              version: 'lse-nuclei-safe-drifted',
              digest: `sha256:${'e'.repeat(64)}`,
            },
          }),
          resolveTarget: async () => {
            resolved = true;
            throw new Error('基线漂移时不应解析目标');
          },
        },
      ),
    ),
    (error: unknown) =>
      error instanceof ScannerClientError &&
      error.code === 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH',
  );

  assert.equal(resolved, false);
  assert.equal(called, false);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.failureCode, 'SERVICE_ASSURANCE_SIDECAR_BASELINE_MISMATCH');
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
});

test('安全检查在执行时重新授权目标并持久化固定预算结果', async () => {
  const { task, run } = await createRun('成功编排');
  const output = await fixture('nuclei-safe-positive.jsonl');
  let request: NucleiScanRequest | null = null;

  await executeServiceAssuranceRun(
    run.id,
    dependencies(async (value) => {
      request = value;
      return response(output);
    }),
  );

  assert.ok(request);
  assert.equal(request.target.pinnedAddress, '93.184.216.34');
  assert.equal(request.budget.maxRequests, 200);
  assert.equal(request.budget.maxConcurrency, 4);
  assert.doesNotMatch(
    JSON.stringify(request),
    /templatePath|command|allowedHosts|apiKey|scanner\.internal/i,
  );

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'COMPLETE');
  assert.equal(
    await prisma.finding.count({
      where: { taskId: task.id, engine: 'service-assurance' },
    }),
    1,
  );
  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-nuclei' },
  });
  assert.equal(engineRun.status, 'SUCCESS');
  assert.equal(engineRun.rawOutput, null);
});

test('OpenAPI 同时执行 Nuclei 与 ZAP 并在全部结束后合并版本和证据', async () => {
  const { task, run } = await createRun('OpenAPI 多引擎', 'SAFE', 'OPENAPI');
  const nucleiOutput = await fixture('nuclei-safe-positive.jsonl');
  const zapOutput = await fixture('zap-safe.json');
  let nucleiRequest: NucleiScanRequest | null = null;
  let zapRequest: ZapScanRequest | null = null;

  const deps = dependencies(async (request) => {
    nucleiRequest = request;
    return response(nucleiOutput);
  });
  Object.assign(deps, {
    loadZapRuntime: () => ({
      baseUrl: 'http://zap.internal:8097',
      expectedEngineDigest: `sha256:${'e'.repeat(64)}`,
      ruleset: {
        version: 'lse-nuclei-safe-2026.08.30',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    }),
    executeZap: async (request: ZapScanRequest) => {
      zapRequest = request;
      return zapResponse(zapOutput);
    },
  });

  await executeServiceAssuranceRun(run.id, deps);

  assert.ok(nucleiRequest);
  assert.ok(zapRequest);
  assert.equal(zapRequest.targetKind, 'OPENAPI');
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  const versions = stored.engineVersions as Record<string, unknown>;
  assert.ok(versions.nuclei);
  assert.ok(versions.zap);
  const executionChecks = readExecutionChecks(
    await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
  );
  assert.equal(executionChecks.filter((check) => check.status === 'COMPLETED').length, 2);
  const zapCheck = executionChecks.find((check) => check.id === 'zap-api-passive');
  assert.equal(zapCheck?.status, 'UNKNOWN');
  assert.equal(zapCheck?.requestCount, null);
  assert.equal(
    buildExecutionSummary(
      'SAFE',
      'OPENAPI',
      await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
    ).requestCount,
    7,
  );

  assert.match(zapCheck?.detail ?? '', /未取得.*执行证据/);

  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    2,
  );
  const engineRuns = await prisma.engineRun.findMany({
    where: { taskId: task.id, engine: { startsWith: 'service-assurance-' } },
    orderBy: { engine: 'asc' },
  });
  assert.deepEqual(
    engineRuns.map((item) => [item.engine, item.status]),
    [
      ['service-assurance-nuclei', 'SUCCESS'],
      ['service-assurance-zap', 'SUCCESS'],
    ],
  );
});

test('OpenAPI 的 ZAP 失败时保留 Nuclei 证据并标记覆盖不完整', async () => {
  const { task, run } = await createRun('OpenAPI 可选引擎失败', 'SAFE', 'OPENAPI');
  const nucleiOutput = await fixture('nuclei-safe-positive.jsonl');
  const deps = dependencies(async () => response(nucleiOutput));
  Object.assign(deps, {
    loadZapRuntime: () => ({
      baseUrl: 'http://zap.internal:8097',
      expectedEngineDigest: `sha256:${'e'.repeat(64)}`,
      ruleset: {
        version: 'lse-nuclei-safe-2026.08.30',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    }),
    executeZap: async () => {
      throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_TIMEOUT');
    },
  });

  await executeServiceAssuranceRun(run.id, deps);

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'PARTIAL');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    1,
  );
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 1);
  const engineRuns = await prisma.engineRun.findMany({
    where: { taskId: task.id, engine: { startsWith: 'service-assurance-' } },
    orderBy: { engine: 'asc' },
  });
  assert.deepEqual(
    engineRuns.map((item) => [item.engine, item.status]),
    [
      ['service-assurance-nuclei', 'SUCCESS'],
      ['service-assurance-zap', 'ERROR'],
    ],
  );
  assert.doesNotMatch(JSON.stringify([stored, engineRuns]), /zap\.internal|stack|stderr/i);
});

test('部分 sidecar 输出保留有效证据并显示覆盖不完整', async () => {
  const { task, run } = await createRun('部分编排');
  const output = await fixture('nuclei-safe-positive.jsonl');

  await executeServiceAssuranceRun(
    run.id,
    dependencies(async () =>
      response(output, {
        completed: false,
        execution: {
          requestCount: 2,
          checks: [
            safeExecution().checks[0]!,
            {
              ...safeExecution().checks[1]!,
              status: 'FAILED',
              detail: '请求已发出，但扫描中断，未取得完整结果。',
            },
          ],
        },
        errorCode: 'SERVICE_ASSURANCE_SCAN_INTERRUPTED',
        errorMessage: 'internal stderr must not persist',
      }),
    ),
  );

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  assert.equal(stored.status, 'PARTIAL');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  assert.equal(stored.failureCode, 'SERVICE_ASSURANCE_SCAN_INTERRUPTED');
  assert.equal(stored.failureMessage, '核验未完成或覆盖不完整。');
  assert.equal(
    await prisma.serviceEvidence.count({
      where: { runId: run.id, assessmentId: { not: null } },
    }),
    1,
  );
  assert.doesNotMatch(JSON.stringify(stored), /internal stderr/i);

  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-nuclei' },
  });
  assert.equal(engineRun.status, 'ERROR');
  assert.equal(engineRun.rawOutput, null);
  assert.doesNotMatch(JSON.stringify(engineRun), /internal stderr/i);
});

test('sidecar 超时只保存稳定错误且事务不残留正式风险', async () => {
  const { task, run } = await createRun('超时编排');

  await assert.rejects(
    executeServiceAssuranceRun(
      run.id,
      dependencies(async () => {
        throw new ScannerClientError('SERVICE_ASSURANCE_SIDECAR_TIMEOUT');
      }),
    ),
    (error: unknown) =>
      error instanceof ScannerClientError && error.code === 'SERVICE_ASSURANCE_SIDECAR_TIMEOUT',
  );

  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  assert.equal(stored.failureCode, 'SERVICE_ASSURANCE_SIDECAR_TIMEOUT');
  assert.equal(stored.failureMessage, '安全核验服务响应超时。');
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
  assert.doesNotMatch(JSON.stringify(stored), /scanner\.internal|stack|stderr/i);

  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-nuclei' },
  });
  assert.equal(engineRun.status, 'ERROR');
  assert.equal(engineRun.rawOutput, null);
  assert.equal(engineRun.errorMessage, '安全核验服务响应超时。');
});

test('取消标记在 sidecar 外呼前生效且不生成风险', async () => {
  const { task, run } = await createRun('取消编排');
  let called = false;

  await executeServiceAssuranceRun(
    run.id,
    dependencies(
      async () => {
        called = true;
        return response('');
      },
      { isCancelRequested: async () => true },
    ),
  );

  assert.equal(called, false);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({
    where: { id: run.id },
  });
  assert.equal(stored.status, 'CANCELED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  assert.ok(stored.canceledAt);
  assert.equal(await prisma.finding.count({ where: { taskId: task.id } }), 0);
  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-nuclei' },
  });
  assert.equal(engineRun.status, 'SKIPPED');
  assert.equal(engineRun.rawOutput, null);
});

test('取消组件清单核验会消费一次性上传且不调用 Trivy', async () => {
  const { task, run } = await createRun('取消组件清单', 'SBOM');
  const contentType = 'application/vnd.cyclonedx+json';
  const content = await fixture('cyclonedx-triton-affected.json');
  const parsed = parseSbomUpload({ contentType, content });
  let consumed = 0;
  let trivyCalled = false;

  await executeServiceAssuranceRun(
    run.id,
    dependencies(
      async () => {
        throw new Error('取消组件清单不应调用安全检查适配器');
      },
      {
        isCancelRequested: async () => true,
        takeSbom: async () => {
          consumed += 1;
          return { contentType, content, parsed };
        },
        executeTrivy: async () => {
          trivyCalled = true;
          return trivyResponse('{}');
        },
      },
    ),
  );

  assert.equal(consumed, 1);
  assert.equal(trivyCalled, false);
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'CANCELED');
  const engineRun = await prisma.engineRun.findFirstOrThrow({
    where: { taskId: task.id, engine: 'service-assurance-trivy' },
  });
  assert.equal(engineRun.status, 'SKIPPED');
  assert.equal(engineRun.rawOutput, null);
});

test('旧 sidecar 的成功退出不冒充逐项覆盖完成', async () => {
  const { run } = await createRun('旧 sidecar 无执行遥测');
  await executeServiceAssuranceRun(
    run.id,
    dependencies(async () => response('', { execution: undefined })),
  );
  const stored = await prisma.serviceAssuranceRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.coverageStatus, 'INCOMPLETE');
  const checks = readExecutionChecks(
    await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
  );
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.status === 'UNKNOWN' && check.requestCount === null));
  assert.equal(
    buildExecutionSummary(
      'SAFE',
      'ENDPOINT',
      await prisma.serviceEvidence.findMany({ where: { runId: run.id } }),
    ).requestCount,
    null,
  );
});
