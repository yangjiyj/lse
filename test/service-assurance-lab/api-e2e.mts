import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELED';

interface RunSummary {
  confirmed: number;
  underInvestigation: number;
  notAffected: number;
  fixed: number;
  incomplete: boolean;
  statusMessage: string;
}

interface CustomerRun {
  runId: string;
  taskId: string;
  mode: 'SAFE' | 'DEEP' | 'SBOM';
  status: RunStatus;
  coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'NOT_READY';
  statusMessage: string;
  summary: RunSummary;
}

interface RunDetail {
  run: CustomerRun;
  results: Array<{
    title: string;
    impactStatus: 'UNDER_INVESTIGATION' | 'AFFECTED' | 'NOT_AFFECTED' | 'FIXED';
    evidenceLabel: string;
  }>;
}

interface LabState {
  taskId: string;
  targetId: string;
  auditorUsername: string;
  auditorUserId: string;
  reportId?: string;
  partialRunId?: string;
  staleRunId?: string;
  canceledRunId?: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const apiBase = required('SERVICE_ASSURANCE_E2E_API_BASE');
const stateFile = required('SERVICE_ASSURANCE_E2E_STATE_FILE');
const runtimeDir = required('SERVICE_ASSURANCE_E2E_RUNTIME_DIR');
const evidenceDir = required('SERVICE_ASSURANCE_E2E_EVIDENCE_DIR');
const adminUsername = required('SERVICE_ASSURANCE_E2E_ADMIN_USERNAME');
const adminPassword = required('SERVICE_ASSURANCE_E2E_ADMIN_PASSWORD');
const auditorPassword = required('SERVICE_ASSURANCE_E2E_AUDITOR_PASSWORD');
const negativeUrl = required('SERVICE_ASSURANCE_E2E_NEGATIVE_URL');
const affectedUrl = required('SERVICE_ASSURANCE_E2E_AFFECTED_URL');
const fixedUrl = required('SERVICE_ASSURANCE_E2E_FIXED_URL');
const affectedOpenapiUrl = required('SERVICE_ASSURANCE_E2E_OPENAPI_URL');
const negativeOpenapiUrl = required('SERVICE_ASSURANCE_E2E_NEGATIVE_OPENAPI_URL');
const affectedSbomPath = required('SERVICE_ASSURANCE_E2E_SBOM_AFFECTED');
const fixedSbomPath = required('SERVICE_ASSURANCE_E2E_SBOM_FIXED');
const unsupportedRootSbomPath = required('SERVICE_ASSURANCE_E2E_SBOM_UNSUPPORTED_ROOT');
const missingVersionSbomPath = required('SERVICE_ASSURANCE_E2E_SBOM_MISSING_VERSION');

const forbiddenDeliveryText =
  /\b(?:AIG|Nuclei|ZAP|Trivy)\b|service-assurance|raw\s*json|session\s*id|container|\/opt\/|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

async function loadState(): Promise<LabState> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as LabState;
}

async function saveState(state: LabState): Promise<void> {
  await writeFile(stateFile, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
}

function safeError(document: unknown): string {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return 'unknown error';
  const value = document as Record<string, unknown>;
  const code = typeof value.code === 'string' ? value.code : 'UNKNOWN';
  const message = typeof value.message === 'string' ? value.message : 'request failed';
  return `${code}: ${message}`;
}

async function requestJson<T>(
  token: string | null,
  pathname: string,
  init: RequestInit = {},
  expectedStatus?: number,
): Promise<{ status: number; document: T }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${apiBase}${pathname}`, { ...init, headers });
  const text = await response.text();
  let document: unknown = {};
  try {
    document = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`API ${pathname} returned non-JSON status ${response.status}`);
  }
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, safeError(document));
  } else if (!response.ok) {
    throw new Error(`API ${pathname} failed with ${response.status} ${safeError(document)}`);
  }
  return { status: response.status, document: document as T };
}

async function login(username: string, password: string): Promise<string> {
  const { document } = await requestJson<{ token?: string }>(null, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  assert.equal(typeof document.token, 'string');
  assert.ok(document.token!.length > 20);
  return document.token!;
}

async function createRun(
  token: string,
  taskId: string,
  input:
    | {
        mode: 'SAFE' | 'DEEP';
        targetKind: 'ENDPOINT' | 'OPENAPI';
        targetName: string;
        targetUrl: string;
        authorizationConfirmed: boolean;
      }
    | {
        mode: 'SBOM';
        targetKind: 'SBOM';
        targetName: string;
        sbomPath: string;
      },
): Promise<CustomerRun> {
  const sbom =
    input.mode === 'SBOM'
      ? {
          contentType: 'application/json',
          content: await readFile(input.sbomPath, 'utf8'),
        }
      : undefined;
  const body = {
    taskId,
    mode: input.mode,
    targetKind: input.targetKind,
    targetName: input.targetName,
    ...(input.mode === 'SBOM' ? {} : { targetUrl: input.targetUrl }),
    scopePolicyRef: 'e2e',
    authorizationConfirmed: input.mode === 'SBOM' ? false : input.authorizationConfirmed,
    ...(sbom ? { sbom } : {}),
  };
  const { document } = await requestJson<{ run: CustomerRun }>(token, '/service-assurance/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return document.run;
}

async function waitForRun(token: string, runId: string): Promise<RunDetail> {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const { document } = await requestJson<RunDetail>(
      token,
      `/service-assurance/runs/${encodeURIComponent(runId)}`,
    );
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELED'].includes(document.run.status)) {
      return document;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('service assurance run did not reach a terminal state');
}

async function evidenceHashes(token: string, runId: string): Promise<string[]> {
  const { document } = await requestJson<{ items: Array<{ contentSha256: string }> }>(
    token,
    `/service-assurance/runs/${encodeURIComponent(runId)}/evidence`,
  );
  return [...new Set(document.items.map((item) => item.contentSha256))].sort();
}

function assertCompleted(detail: RunDetail, label: string): void {
  assert.equal(detail.run.status, 'COMPLETED', `${label} status`);
  assert.equal(detail.run.coverageStatus, 'COMPLETE', `${label} coverage`);
  assert.equal(detail.run.summary.incomplete, false, `${label} incomplete summary`);
}

function assertPartial(detail: RunDetail, label: string): void {
  assert.equal(detail.run.status, 'PARTIAL', `${label} status`);
  assert.equal(detail.run.coverageStatus, 'INCOMPLETE', `${label} coverage`);
  assert.equal(detail.run.summary.incomplete, true, `${label} incomplete summary`);
}

function evidenceText(input: {
  title: string;
  mode: string;
  target: string;
  cases: Array<{ label: string; detail: RunDetail; hashes: string[] }>;
}): string {
  const lines = [`${input.title}`, '', `模式: ${input.mode}`, `受控目标: ${input.target}`, ''];
  for (const item of input.cases) {
    lines.push(`场景: ${item.label}`);
    lines.push(`状态: ${item.detail.run.status}`);
    lines.push(`覆盖: ${item.detail.run.coverageStatus}`);
    lines.push(`正式风险: ${item.detail.run.summary.confirmed}`);
    lines.push(`待核验线索: ${item.detail.run.summary.underInvestigation}`);
    lines.push(`不受影响: ${item.detail.run.summary.notAffected}`);
    lines.push(`已修复: ${item.detail.run.summary.fixed}`);
    lines.push(`覆盖不完整: ${item.detail.run.summary.incomplete ? '是' : '否'}`);
    lines.push('证据哈希:');
    lines.push(...(item.hashes.length > 0 ? item.hashes.map((hash) => `- ${hash}`) : ['- 无']));
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

async function primary(): Promise<void> {
  const state = await loadState();
  const adminToken = await login(adminUsername, adminPassword);
  const auditorToken = await login(state.auditorUsername, auditorPassword);

  const { document: readiness } = await requestJson<unknown>(
    adminToken,
    '/service-assurance/readiness',
  );
  assert.doesNotMatch(JSON.stringify(readiness), /nuclei|trivy|zap|digest|url|container|path/i);
  assert.deepEqual(
    (readiness as { modes: Array<{ mode: string; ready: boolean }> }).modes.map((mode) => ({
      mode: mode.mode,
      ready: mode.ready,
    })),
    [
      { mode: 'SAFE', ready: true },
      { mode: 'DEEP', ready: true },
      { mode: 'SBOM', ready: true },
    ],
  );

  await requestJson(
    auditorToken,
    `/service-assurance/runs?taskId=${encodeURIComponent(state.taskId)}`,
    {},
    404,
  );
  await requestJson(
    auditorToken,
    '/service-assurance/runs',
    {
      method: 'POST',
      body: JSON.stringify({
        taskId: state.taskId,
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '越权请求',
        targetUrl: affectedUrl,
        scopePolicyRef: 'e2e',
        authorizationConfirmed: false,
      }),
    },
    403,
  );
  await requestJson(
    adminToken,
    '/service-assurance/runs',
    {
      method: 'POST',
      body: JSON.stringify({
        taskId: state.taskId,
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: 'SSRF 负样本',
        targetUrl: 'http://169.254.169.254/latest/meta-data',
        scopePolicyRef: 'e2e',
        authorizationConfirmed: false,
      }),
    },
    400,
  );
  await requestJson(
    adminToken,
    '/service-assurance/runs',
    {
      method: 'POST',
      body: JSON.stringify({
        taskId: state.taskId,
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '禁止字段负样本',
        targetUrl: affectedUrl,
        scopePolicyRef: 'e2e',
        authorizationConfirmed: false,
        command: 'not-allowed',
      }),
    },
    400,
  );

  const safeNegative = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '普通 API 网关 JSON 负样本',
        targetUrl: negativeUrl,
        authorizationConfirmed: false,
      })
    ).runId,
  );
  assertCompleted(safeNegative, 'SAFE negative');
  assert.equal(safeNegative.run.summary.confirmed, 0);
  assert.equal(safeNegative.run.summary.underInvestigation, 0);
  assert.doesNotMatch(JSON.stringify(safeNegative.results), /triton/i);

  const safePositive = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '受控配置与组件线索正样本',
        targetUrl: affectedUrl,
        authorizationConfirmed: false,
      })
    ).runId,
  );
  assertCompleted(safePositive, 'SAFE positive');
  assert.ok(safePositive.run.summary.confirmed >= 1);
  assert.ok(safePositive.run.summary.underInvestigation >= 1);
  assert.ok(safePositive.results.some((item) => item.title === '响应缺少类型嗅探防护'));
  assert.ok(safePositive.results.some((item) => item.title === '疑似组件、待核验线索'));

  const fixedEndpoint = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SAFE',
        targetKind: 'ENDPOINT',
        targetName: '受控配置修复负样本',
        targetUrl: fixedUrl,
        authorizationConfirmed: false,
      })
    ).runId,
  );
  assertCompleted(fixedEndpoint, 'SAFE fixed endpoint');
  assert.equal(fixedEndpoint.run.summary.confirmed, 0);

  const deepNegative = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'DEEP',
        targetKind: 'OPENAPI',
        targetName: '授权深度核验负样本',
        targetUrl: negativeOpenapiUrl,
        authorizationConfirmed: true,
      })
    ).runId,
  );
  assertCompleted(deepNegative, 'DEEP negative');
  assert.equal(deepNegative.run.summary.confirmed, 0);
  assert.ok(!deepNegative.results.some((item) => item.title === '未授权管理状态接口'));

  const deepPositive = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'DEEP',
        targetKind: 'OPENAPI',
        targetName: '授权深度核验正样本',
        targetUrl: affectedOpenapiUrl,
        authorizationConfirmed: true,
      })
    ).runId,
  );
  assertCompleted(deepPositive, 'DEEP positive');
  assert.ok(deepPositive.run.summary.confirmed >= 1);
  assert.ok(deepPositive.results.some((item) => item.title === '未授权管理状态接口'));

  const sbomAffected = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName: '受控组件清单受影响样本',
        sbomPath: affectedSbomPath,
      })
    ).runId,
  );
  assertPartial(sbomAffected, 'SBOM affected');
  assert.ok(sbomAffected.run.summary.confirmed >= 1);
  assert.ok(sbomAffected.results.some((item) => item.title.includes('版本受已知漏洞影响')));

  const sbomUnsupportedRoot = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName: '受控组件清单不支持生态样本',
        sbomPath: unsupportedRootSbomPath,
      })
    ).runId,
  );
  assert.equal(sbomUnsupportedRoot.run.status, 'PARTIAL');
  assert.equal(sbomUnsupportedRoot.run.coverageStatus, 'INCOMPLETE');
  assert.equal(sbomUnsupportedRoot.run.summary.incomplete, true);
  assert.ok(
    sbomUnsupportedRoot.run.summary.confirmed >= 1,
    'unsupported root must not discard confirmed risks',
  );

  const sbomFixed = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName: '受控组件清单修复版本样本',
        sbomPath: fixedSbomPath,
      })
    ).runId,
  );
  assertPartial(sbomFixed, 'SBOM fixed');
  assert.equal(sbomFixed.run.summary.confirmed, 0);
  assert.ok(sbomFixed.run.summary.notAffected >= 1, 'fixed component must be explicit');

  const sbomMissingVersion = await waitForRun(
    adminToken,
    (
      await createRun(adminToken, state.taskId, {
        mode: 'SBOM',
        targetKind: 'SBOM',
        targetName: '受控组件清单缺版本样本',
        sbomPath: missingVersionSbomPath,
      })
    ).runId,
  );
  assertPartial(sbomMissingVersion, 'SBOM missing version');
  assert.equal(sbomMissingVersion.run.summary.confirmed, 0);
  assert.ok(
    sbomMissingVersion.run.summary.underInvestigation >= 1,
    'missing version must remain under investigation',
  );

  const safeHashes = await evidenceHashes(adminToken, safePositive.run.runId);
  const deepHashes = await evidenceHashes(adminToken, deepPositive.run.runId);
  const sbomHashes = await evidenceHashes(adminToken, sbomAffected.run.runId);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, 'mode-safe.txt'),
    evidenceText({
      title: 'AI 服务安全核验 SAFE 受控验收证据',
      mode: '安全检查',
      target: '隔离网段内的普通网关、受影响服务与修复服务',
      cases: [
        { label: '普通 JSON 误报回归', detail: safeNegative, hashes: [] },
        { label: '配置命中与弱组件线索', detail: safePositive, hashes: safeHashes },
        { label: '配置修复负样本', detail: fixedEndpoint, hashes: [] },
      ],
    }),
  );
  await writeFile(
    path.join(evidenceDir, 'mode-deep.txt'),
    evidenceText({
      title: 'AI 服务安全核验 DEEP 受控验收证据',
      mode: '授权深度核验',
      target: '隔离网段内的固定 OpenAPI 正负样本',
      cases: [
        { label: '认证有效负样本', detail: deepNegative, hashes: [] },
        { label: '未授权管理状态正样本', detail: deepPositive, hashes: deepHashes },
      ],
    }),
  );
  await writeFile(
    path.join(evidenceDir, 'mode-sbom.txt'),
    evidenceText({
      title: 'AI 服务安全核验 SBOM 受控验收证据',
      mode: '组件清单核验',
      target: '固定 CycloneDX 受影响、修复版本与缺版本样本',
      cases: [
        { label: '受影响版本', detail: sbomAffected, hashes: sbomHashes },
        { label: '不支持生态导致覆盖不完整', detail: sbomUnsupportedRoot, hashes: [] },
        { label: '修复版本', detail: sbomFixed, hashes: [] },
        { label: '缺版本线索', detail: sbomMissingVersion, hashes: [] },
      ],
    }),
  );

  const { document: report } = await requestJson<{
    id: string;
    title: string;
    content: string;
    summary: unknown;
  }>(adminToken, '/reports', {
    method: 'POST',
    body: JSON.stringify({
      taskId: state.taskId,
      kind: 'service_assurance',
      explanationMode: 'local',
    }),
  });
  assert.equal(report.title, 'AI 服务安全核验报告');
  assert.doesNotMatch(
    JSON.stringify({ title: report.title, content: report.content, summary: report.summary }),
    forbiddenDeliveryText,
  );
  const pdfResponse = await fetch(`${apiBase}/reports/${encodeURIComponent(report.id)}/download`, {
    headers: { authorization: `Bearer ${adminToken}`, accept: 'application/pdf' },
  });
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get('content-type') ?? '', /application\/pdf/);
  await writeFile(
    path.join(runtimeDir, 'service-assurance-report.pdf'),
    Buffer.from(await pdfResponse.arrayBuffer()),
  );
  state.reportId = report.id;
  await saveState(state);
  console.log('[ok] SAFE, DEEP, SBOM, permissions, SSRF and report scenarios passed');
}

async function queueSpecial(kind: 'partial' | 'stale' | 'canceled'): Promise<void> {
  const state = await loadState();
  const token = await login(adminUsername, adminPassword);
  const run =
    kind === 'partial'
      ? await createRun(token, state.taskId, {
          mode: 'DEEP',
          targetKind: 'OPENAPI',
          targetName: '可选核验服务失败样本',
          targetUrl: affectedOpenapiUrl,
          authorizationConfirmed: true,
        })
      : await createRun(token, state.taskId, {
          mode: 'SAFE',
          targetKind: 'ENDPOINT',
          targetName: kind === 'stale' ? '规则基线过期样本' : '取消状态样本',
          targetUrl: affectedUrl,
          authorizationConfirmed: false,
        });
  if (kind === 'partial') state.partialRunId = run.runId;
  if (kind === 'stale') state.staleRunId = run.runId;
  if (kind === 'canceled') {
    state.canceledRunId = run.runId;
    await requestJson(token, `/service-assurance/runs/${encodeURIComponent(run.runId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }
  await saveState(state);
  console.log(`[ok] ${kind} scenario queued`);
}

async function waitSpecial(kind: 'partial' | 'stale' | 'canceled'): Promise<void> {
  const state = await loadState();
  const token = await login(adminUsername, adminPassword);
  const runId =
    kind === 'partial'
      ? state.partialRunId
      : kind === 'stale'
        ? state.staleRunId
        : state.canceledRunId;
  assert.ok(runId, `${kind} run is missing from state`);
  const detail = await waitForRun(token, runId!);
  if (kind === 'canceled') {
    assert.equal(detail.run.status, 'CANCELED');
    assert.equal(detail.run.coverageStatus, 'INCOMPLETE');
  } else {
    assert.equal(detail.run.status, 'PARTIAL');
    assert.equal(detail.run.coverageStatus, 'INCOMPLETE');
    assert.equal(detail.run.summary.incomplete, true);
  }
  const output = path.join(runtimeDir, `${kind}-result.json`);
  await writeFile(
    output,
    JSON.stringify({
      scenario: kind,
      status: detail.run.status,
      coverageStatus: detail.run.coverageStatus,
      summary: detail.run.summary,
    }),
  );
  const evidenceFile = path.join(
    evidenceDir,
    kind === 'partial' ? 'mode-deep.txt' : 'mode-safe.txt',
  );
  await appendFile(
    evidenceFile,
    [
      '',
      `场景: ${
        kind === 'partial' ? '可选核验服务失败' : kind === 'stale' ? '规则基线过期' : '用户取消'
      }`,
      `状态: ${detail.run.status}`,
      `覆盖: ${detail.run.coverageStatus}`,
      '覆盖不完整: 是',
      '',
    ].join('\n'),
  );
  console.log(`[ok] ${kind} scenario reached the required terminal state`);
}

const command = process.argv[2];
if (command === 'primary') await primary();
else if (command === 'queue-partial') await queueSpecial('partial');
else if (command === 'wait-partial') await waitSpecial('partial');
else if (command === 'queue-stale') await queueSpecial('stale');
else if (command === 'wait-stale') await waitSpecial('stale');
else if (command === 'queue-canceled') await queueSpecial('canceled');
else if (command === 'wait-canceled') await waitSpecial('canceled');
else throw new Error('expected primary or a supported special-scenario command');
