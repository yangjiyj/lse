import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTaskReport,
  type BuiltReport,
  type ReportInputData,
} from '../src/modules/reports/report-builder.js';
import { buildReportPdfDoc } from '../src/modules/reports/pdf.js';
import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import {
  redactReportInputData,
  redactReportJson,
  redactReportSnapshot,
} from '../src/modules/reports/report-redaction.js';
import { buildMultilingualCoverageReport } from '../src/modules/reports/specialized/multilingual-coverage.js';
import { hashSensitive } from '../src/lib/redact.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');
const SECRETS = {
  bearer: 'report-bearer-secret-123456789',
  sk: 'sk-report-secret-1234567890',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXBvcnQifQ.c2lnbmF0dXJlLXZhbHVl',
  basic: 'QWxhZGRpbjpvcGVuU2VzYW1l',
  apiKey: 'report-api-key-secret',
  password: 'report-password-secret',
  detailSecret: 'detail-secret-value',
  titleSecret: 'sk-title-secret-1234567890',
} as const;

function reportInput(): ReportInputData {
  return {
    task: {
      id: 'task-redaction',
      name: '客户证据脱敏任务',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge'],
      totalQuestions: 1,
      processedQuestions: 1,
      passedCount: 0,
      failedCount: 1,
      errorCount: 0,
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      modelTarget: { name: '被测模型', provider: 'openai-compatible', model: 'test-model' },
      questionSets: [{ name: '脱敏题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { FAIL: 1 },
    findings: [
      {
        stableId: 'finding-redaction',
        resultId: 'result-redaction',
        engine: 'rule-judge',
        riskCategory: 'credential_exposure',
        severity: 'HIGH',
        verdict: 'FAIL',
        reviewStatus: 'NEEDS_REVIEW',
        title: `发现 ${SECRETS.titleSecret}`,
        evidence: `Authorization: Basic ${SECRETS.basic}`,
        reviewReason: `api_key: ${SECRETS.apiKey}`,
        detail: {
          password: SECRETS.password,
          nested: {
            context: `secret: ${SECRETS.detailSecret}`,
            ordinary: '正常中文证据保持不变',
          },
        },
      },
    ],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 1,
        skippedCount: 0,
        durationMs: 10,
        errorMessage: null,
      },
    ],
    wrongAnswers: [
      {
        resultId: 'result-redaction',
        questionContent: `JWT ${SECRETS.jwt}`,
        modelResponse: `password: ${SECRETS.password}`,
        riskCategory: 'credential_exposure',
        severity: 'HIGH',
        engine: 'rule-judge',
        reason: `secret: ${SECRETS.detailSecret}`,
      },
    ],
    results: [
      {
        id: 'result-redaction',
        prompt: `Authorization: Bearer ${SECRETS.bearer}`,
        response: `${SECRETS.sk} <MASKED>`,
        finalVerdict: 'FAIL',
        status: 'SUCCESS',
        question: {
          content: '请检查这段凭据是否泄露',
          type: 'GENERAL',
          shouldRefuse: false,
          language: 'zh',
          severity: 'HIGH',
          category: 'credential_exposure',
        },
      },
    ],
    generatedAt: NOW,
  };
}

function assertNoRawSecrets(value: unknown): string {
  const serialized = JSON.stringify(value);
  for (const secret of Object.values(SECRETS)) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  return serialized;
}

test('报告数据边界统一脱敏字符串和深层 detail，同时保留结构与正常中文', () => {
  const sanitized = redactReportInputData(reportInput());
  const serialized = assertNoRawSecrets(sanitized);

  assert.match(serialized, /hash:[a-f0-9]{12}/);
  assert.match(serialized, /内容已在网关侧脱敏/);
  assert.equal(
    (sanitized.findings[0]!.detail as { nested: { ordinary: string } }).nested.ordinary,
    '正常中文证据保持不变',
  );
  assert.equal(sanitized.generatedAt, NOW, '深层脱敏不得破坏 Date 快照');
});

test('经报告数据边界生成的 content、summary 和风险证据组合均不含原始凭据', () => {
  const built = buildTaskReport(redactReportInputData(reportInput()));
  const serialized = assertNoRawSecrets({ content: built.content, summary: built.summary });

  assert.ok(built.summary.riskEvidencePortfolio);
  assert.match(serialized, /hash:[a-f0-9]{12}|内容已在网关侧脱敏/);
});

test('风险证据快照对绕过数据边界的调用者仍执行防御性脱敏', () => {
  const built = buildTaskReport(reportInput());
  const portfolio = built.summary.riskEvidencePortfolio;
  assert.ok(portfolio);

  const serialized = JSON.stringify(portfolio);
  for (const secret of [SECRETS.basic, SECRETS.apiKey, SECRETS.titleSecret]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.match(serialized, /hash:[a-f0-9]{12}/);
});

test('冻结报告快照重复脱敏保持枚举、数字、null、Date 与业务类别结构', () => {
  const createdAt = new Date('2026-07-11T14:00:00.000Z');
  const snapshot = {
    createdAt,
    charts: {
      verdict: [{ key: 'PASS', value: 3 }],
      engineStatus: [{ key: 'SKIPPED', value: 1 }],
      severity: [{ key: 'CRITICAL', value: 2 }],
    },
    riskAttribution: { keyCount: 3, suppressionKey: null },
    riskDistribution: { byRiskCategory: { secret_egress: 2 } },
  };

  const once = redactReportSnapshot(snapshot) as typeof snapshot;
  const twice = redactReportSnapshot(once) as typeof snapshot;
  assert.deepEqual(twice, once);
  assert.equal(once.createdAt, createdAt);
  assert.equal(once.charts.verdict[0]!.key, 'PASS');
  assert.equal(once.charts.engineStatus[0]!.key, 'SKIPPED');
  assert.equal(once.charts.severity[0]!.key, 'CRITICAL');
  assert.equal(once.riskAttribution.keyCount, 3);
  assert.equal(once.riskAttribution.suppressionKey, null);
  assert.equal(once.riskDistribution.byRiskCategory.secret_egress, 2);
});

test('报告边界覆盖真实凭据、动态计数键与敏感父路径，同时保留已知报告结构', () => {
  const aws = 'AKIA1234567890ABCDEF';
  const github = 'gho_1234567890abcdefghijklmnopqrstuvwxyz';
  const bearer = 'snapshot-bearer-secret-123456789';
  const password = 'snapshot-parent-password';
  const rawKey = 'opaque-raw-detail-key';
  const rawSuppressionKey = 'opaque-raw-suppression-key';
  const pem = [
    '-----BEGIN PRIVATE KEY-----',
    'c25hcHNob3QtcHJpdmF0ZS1rZXk=',
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const snapshot = {
    riskDistribution: { byRiskCategory: { [aws]: 1, secret_egress: 2 } },
    github,
    pem,
    authorization: { value: `Bearer ${bearer}` },
    password: { value: password },
    charts: { verdict: [{ key: 'PASS', value: 1 }] },
    rawDetail: {
      key: rawKey,
      keyCount: 3,
      suppressionKey: rawSuppressionKey,
      count: 2,
      enabled: true,
      empty: null,
    },
  };

  const redacted = redactReportSnapshot(snapshot) as any;
  const serialized = JSON.stringify(redacted);
  for (const secret of [aws, github, bearer, password, pem, rawKey, rawSuppressionKey]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(redacted.riskDistribution.byRiskCategory.secret_egress, 2);
  assert.equal(
    Object.values(redacted.riskDistribution.byRiskCategory).includes(1),
    true,
    '动态凭据 key 的计数值应保留',
  );
  assert.equal(redacted.charts.verdict[0].key, 'PASS');
  assert.match(redacted.rawDetail.key, /^hash:[0-9a-f]{12}$/);
  assert.match(String(redacted.rawDetail.keyCount), /^hash:[0-9a-f]{12}$/);
  assert.match(redacted.rawDetail.suppressionKey, /^hash:[0-9a-f]{12}$/);
  assert.equal(redacted.rawDetail.count, 2);
  assert.equal(redacted.rawDetail.enabled, true);
  assert.equal(redacted.rawDetail.empty, null);

  const input = reportInput();
  input.findings[0]!.suppressionKey = '0123456789abcdef01234567';
  const inputOnce = redactReportInputData(input);
  const inputTwice = redactReportInputData(inputOnce);
  assert.deepEqual(inputTwice, inputOnce);
  assert.equal(inputOnce.findings[0]!.suppressionKey, '0123456789abcdef01234567');
  assert.equal(inputOnce.generatedAt, NOW);
});

test('复合凭据字段及敏感父路径遮蔽字符串和标量，同时保留普通计数与快照类型', () => {
  const createdAt = new Date('2026-07-11T15:00:00.000Z');
  const snapshot = {
    'X-API-Key': 'opaque-x-api-key',
    api_token: 'opaque-api-token',
    db_password: 123456,
    proxy_authorization: true,
    aws_secret_access_key: 'opaque-aws-secret-access-key',
    SecretAccessKey: 'opaque-secret-access-key',
    AccessKeyId: 'opaque-access-key-id',
    sessionToken: 'opaque-session-token',
    authToken: false,
    privateKeyPem: 'opaque-private-key-pem',
    credentials: [
      {
        label: 'opaque-parent-label',
        nested: [{ value: 'opaque-parent-value', enabled: true, retryCount: 2 }],
      },
    ],
    detail: {
      key: 'opaque-generic-key',
      keyCount: 3,
      suppressionKey: 'opaque-raw-suppression-key',
      businessKey: 'opaque-business-key',
      secretEgress: 'opaque-secret-egress',
      ordinaryNumber: 123456,
      ordinaryBoolean: true,
      empty: null,
      createdAt,
    },
  };

  const redacted = redactReportSnapshot(snapshot) as any;
  for (const value of [
    redacted['X-API-Key'],
    redacted.api_token,
    redacted.db_password,
    redacted.proxy_authorization,
    redacted.aws_secret_access_key,
    redacted.SecretAccessKey,
    redacted.AccessKeyId,
    redacted.sessionToken,
    redacted.authToken,
    redacted.privateKeyPem,
    redacted.credentials[0].label,
    redacted.credentials[0].nested[0].value,
    redacted.credentials[0].nested[0].enabled,
    redacted.credentials[0].nested[0].retryCount,
    redacted.detail.key,
    redacted.detail.suppressionKey,
    redacted.detail.businessKey,
    redacted.detail.secretEgress,
  ]) {
    assert.match(String(value), /^hash:[0-9a-f]{12}$/);
  }
  assert.match(String(redacted.detail.keyCount), /^hash:[0-9a-f]{12}$/);
  assert.equal(redacted.detail.ordinaryNumber, 123456);
  assert.equal(redacted.detail.ordinaryBoolean, true);
  assert.equal(redacted.detail.empty, null);
  assert.equal(redacted.detail.createdAt, createdAt);
});

test('动态凭据键碰撞使用稳定序号保全所有值，且 own __proto__ 不污染原型', () => {
  const rawCredentialKey = 'AKIA1234567890ABCDEF';
  const hashedKey = hashSensitive(rawCredentialKey);
  const snapshot = JSON.parse(
    JSON.stringify({
      [rawCredentialKey]: { source: 'raw-credential-key' },
      [hashedKey]: { source: 'preexisting-hash-key' },
      [`${hashedKey}#2`]: { source: 'preexisting-suffixed-key' },
      __proto_placeholder__: null,
    }).replace(
      '"__proto_placeholder__":null',
      '"__proto__":{"polluted":true,"charts":{"inherited":true}}',
    ),
  ) as Record<string, unknown>;

  const once = redactReportSnapshot(snapshot) as Record<string, any>;
  const twice = redactReportSnapshot(once) as Record<string, any>;

  assert.deepEqual(twice, once);
  assert.deepEqual(once[hashedKey], { source: 'raw-credential-key' });
  assert.deepEqual(once[`${hashedKey}#2`], { source: 'preexisting-hash-key' });
  assert.deepEqual(once[`${hashedKey}#3`], { source: 'preexisting-suffixed-key' });
  assert.equal(Object.hasOwn(once, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(once), Object.prototype);
  assert.equal(Object.hasOwn(once, 'charts'), false);
  assert.equal(once.charts, undefined);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('动态计数 map 保留真实风险类别与数值，只遮蔽凭据形态的动态键', () => {
  const awsKey = 'AKIA1234567890ABCDEF';
  const skKey = 'sk-dynamic-count-map-1234567890';
  const snapshot = {
    riskDistribution: {
      byRiskCategory: {
        sensitive_info_secret: 3,
        access_token: 2,
        private_key: 1,
        [awsKey]: 4,
        [skKey]: 5,
      },
      byRiskDomain: { access_token: 6 },
      bySeverity: { private_key: 7 },
    },
    verdictCounts: { access_token: 8 },
    verdictDistribution: { private_key: 9 },
    severityDistribution: { sensitive_info_secret: 10 },
    severityCounts: { access_token: 11 },
  };

  const once = redactReportSnapshot(snapshot) as any;
  const twice = redactReportSnapshot(once) as any;

  assert.deepEqual(twice, once);
  assert.equal(once.riskDistribution.byRiskCategory.sensitive_info_secret, 3);
  assert.equal(once.riskDistribution.byRiskCategory.access_token, 2);
  assert.equal(once.riskDistribution.byRiskCategory.private_key, 1);
  assert.equal(once.riskDistribution.byRiskDomain.access_token, 6);
  assert.equal(once.riskDistribution.bySeverity.private_key, 7);
  assert.equal(once.verdictCounts.access_token, 8);
  assert.equal(once.verdictDistribution.private_key, 9);
  assert.equal(once.severityDistribution.sensitive_info_secret, 10);
  assert.equal(once.severityCounts.access_token, 11);
  assert.equal(
    Object.values(once.riskDistribution.byRiskCategory).reduce(
      (sum: number, count) => sum + Number(count),
      0,
    ),
    15,
  );
  const serialized = JSON.stringify(once);
  assert.doesNotMatch(serialized, new RegExp(awsKey));
  assert.doesNotMatch(serialized, new RegExp(skKey));
  assert.equal(
    Object.keys(once.riskDistribution.byRiskCategory).filter((key) => /^hash:/.test(key)).length,
    2,
  );
});

test('路径规则只放行快照图表 key 和 findings suppressionKey，raw detail 包装凭据全部遮蔽', () => {
  const createdAt = new Date('2026-07-11T16:00:00.000Z');
  const snapshot = {
    charts: { verdict: [{ key: 'PASS', value: 1 }] },
    findings: [{ suppressionKey: '0123456789abcdef01234567' }],
    detail: {
      key: 'opaque-generic-key',
      businessKey: 'opaque-business-key',
      secretEgress: 'opaque-secret-egress',
      apiKeyValue: 'opaque-api-key-value',
      accessTokenValue: 'opaque-access-token-value',
      passwordHash: 'opaque-password-hash',
      authorizationHeader: 'opaque-authorization-header',
      cookieHeader: 'opaque-cookie-header',
      keyCount: 3,
      ordinaryCount: 4,
      ordinaryNumber: 123456,
      empty: null,
      createdAt,
    },
  };

  const redacted = redactReportSnapshot(snapshot) as any;
  assert.equal(redacted.charts.verdict[0].key, 'PASS');
  assert.match(String(redacted.findings[0].suppressionKey), /^hash:[0-9a-f]{12}$/);
  for (const value of [
    redacted.detail.key,
    redacted.detail.businessKey,
    redacted.detail.secretEgress,
    redacted.detail.apiKeyValue,
    redacted.detail.accessTokenValue,
    redacted.detail.passwordHash,
    redacted.detail.authorizationHeader,
    redacted.detail.cookieHeader,
  ]) {
    assert.match(String(value), /^hash:[0-9a-f]{12}$/);
  }
  assert.match(String(redacted.detail.keyCount), /^hash:[0-9a-f]{12}$/);
  assert.equal(redacted.detail.ordinaryCount, 4);
  assert.equal(redacted.detail.ordinaryNumber, 123456);
  assert.equal(redacted.detail.empty, null);
  assert.equal(redacted.detail.createdAt, createdAt);

  const inputMode = redactReportJson({
    charts: { verdict: [{ key: 'PASS', value: 1 }] },
  }) as any;
  assert.match(String(inputMode.charts.verdict[0].key), /^hash:[0-9a-f]{12}$/);
});

test('raw input detail 伪造动态计数 map 名称不能绕过字段脱敏', () => {
  const forged = redactReportJson({
    findings: [
      {
        detail: {
          byRiskCategory: {
            api_token: 123456,
          },
        },
      },
    ],
  }) as any;

  assert.match(String(forged.findings[0].detail.byRiskCategory.api_token), /^hash:[0-9a-f]{12}$/);
});

test('canonical chart 与 suppressionKey 只在精确模式、路径和格式下放行', () => {
  const validSuppressionKey = '0123456789abcdef01234567';
  const snapshot = redactReportSnapshot({
    charts: {
      severity: [{ key: 'HIGH', value: 1 }],
      verdict: [{ key: 'PASS', value: 1 }],
      riskCategory: [{ key: 'risk-category', value: 1 }],
      riskDomain: [{ key: 'risk-domain', value: 1 }],
      engineStatus: [{ key: 'SUCCESS', value: 1 }],
      evil: [{ key: 'opaque-evil-series', value: 1 }],
      risk_category: [{ key: 'opaque-series-alias', value: 1 }],
    },
    Charts: { verdict: [{ key: 'opaque-chart-alias', value: 1 }] },
    summary: {
      charts: { verdict: [{ key: 'FAIL', value: 1 }] },
      extra: { charts: { verdict: [{ key: 'opaque-extra-ancestor', value: 1 }] } },
    },
    fake: { charts: { verdict: [{ key: 'opaque-fake-ancestor', value: 1 }] } },
    detail: { charts: { verdict: [{ key: 'opaque-detail-chart', value: 1 }] } },
    findings: [{ suppressionKey: validSuppressionKey }],
  }) as any;

  assert.deepEqual(
    [
      snapshot.charts.severity[0].key,
      snapshot.charts.verdict[0].key,
      snapshot.charts.riskCategory[0].key,
      snapshot.charts.riskDomain[0].key,
      snapshot.charts.engineStatus[0].key,
      snapshot.summary.charts.verdict[0].key,
    ],
    ['HIGH', 'PASS', 'risk-category', 'risk-domain', 'SUCCESS', 'FAIL'],
  );
  for (const value of [
    snapshot.charts.evil[0].key,
    snapshot.charts.risk_category[0].key,
    snapshot.Charts.verdict[0].key,
    snapshot.summary.extra.charts.verdict[0].key,
    snapshot.fake.charts.verdict[0].key,
    snapshot.detail.charts.verdict[0].key,
    snapshot.findings[0].suppressionKey,
  ]) {
    assert.match(String(value), /^hash:[0-9a-f]{12}$/);
  }

  const input = redactReportJson({
    findings: [
      { suppressionKey: validSuppressionKey },
      { suppressionKey: 'invalid-suppression-key' },
      { detail: { suppressionKey: validSuppressionKey } },
      { suppression_key: validSuppressionKey },
    ],
    fake: { findings: [{ suppressionKey: validSuppressionKey }] },
  }) as any;
  assert.equal(input.findings[0].suppressionKey, validSuppressionKey);
  assert.match(String(input.findings[1].suppressionKey), /^hash:[0-9a-f]{12}$/);
  assert.match(String(input.findings[2].detail.suppressionKey), /^hash:[0-9a-f]{12}$/);
  assert.match(String(input.findings[3].suppression_key), /^hash:[0-9a-f]{12}$/);
  assert.match(String(input.fake.findings[0].suppressionKey), /^hash:[0-9a-f]{12}$/);
});

test('真实多语言专项报告的 byLanguage 图表经快照脱敏后保持语言键', () => {
  const built = buildMultilingualCoverageReport(redactReportInputData(reportInput()));
  assert.equal(built.summary.charts.byLanguage?.[0]?.key, 'zh');

  const snapshot = redactReportSnapshot(built);
  assert.equal(snapshot.summary.charts.byLanguage?.[0]?.key, 'zh');
  assert.equal(snapshot.summary.charts.byLanguage?.[0]?.value, 1);
});

test('动态计数 map 丢弃普通分类名下的所有非法计数值', () => {
  const snapshot = redactReportSnapshot({
    riskDistribution: {
      byRiskCategory: {
        valid_count: 0,
        sensitive_info_secret: 3,
        forbidden_content: 'opaque-string-count',
        ordinary_negative: -1,
        ordinary_infinity: Number.POSITIVE_INFINITY,
        ordinary_boolean: true,
        ordinary_object: { nested: 'opaque-object-count' },
        ordinary_null: null,
      },
    },
  }) as any;

  assert.equal(snapshot.riskDistribution.byRiskCategory.valid_count, 0);
  assert.equal(snapshot.riskDistribution.byRiskCategory.sensitive_info_secret, 3);
  for (const key of [
    'forbidden_content',
    'ordinary_negative',
    'ordinary_infinity',
    'ordinary_boolean',
    'ordinary_object',
    'ordinary_null',
  ]) {
    assert.equal(Object.hasOwn(snapshot.riskDistribution.byRiskCategory, key), false);
  }

  const input = redactReportJson({
    verdictCounts: {
      PASS: 1,
      ordinary_string: 'opaque-input-count',
      ordinary_negative: -1,
      ordinary_infinity: Number.POSITIVE_INFINITY,
      ordinary_boolean: false,
      ordinary_object: { nested: 1 },
      ordinary_null: null,
    },
  }) as any;
  assert.equal(input.verdictCounts.PASS, 1);
  for (const key of [
    'ordinary_string',
    'ordinary_negative',
    'ordinary_infinity',
    'ordinary_boolean',
    'ordinary_object',
    'ordinary_null',
  ]) {
    assert.equal(Object.hasOwn(input.verdictCounts, key), false);
  }
});

test('动态计数 map 丢弃非法值且拒绝别名路径', () => {
  const snapshot = redactReportSnapshot({
    riskDistribution: {
      byRiskCategory: {
        access_token: 2,
        zero_token: 0,
        api_token: 'opaque-string-count',
        private_key: { nested: 'opaque-object-count' },
        auth_token: true,
        password: -1,
        secret: Number.POSITIVE_INFINITY,
      },
    },
  }) as any;

  assert.equal(snapshot.riskDistribution.byRiskCategory.access_token, 2);
  assert.equal(snapshot.riskDistribution.byRiskCategory.zero_token, 0);
  for (const key of ['api_token', 'private_key', 'auth_token', 'password', 'secret']) {
    assert.equal(Object.hasOwn(snapshot.riskDistribution.byRiskCategory, key), false);
  }

  const input = redactReportJson({
    verdictCounts: { access_token: 1, api_token: 'opaque-input-count' },
  }) as any;
  assert.equal(input.verdictCounts.access_token, 1);
  assert.equal(Object.hasOwn(input.verdictCounts, 'api_token'), false);
  const aliases = {
    input: redactReportJson({ verdict_counts: { api_token: 123456 } }) as any,
    snapshot: redactReportSnapshot({
      risk_distribution: { by_risk_category: { api_token: 123456 } },
    }) as any,
  };
  assert.match(String(aliases.input.verdict_counts.api_token), /^hash:[0-9a-f]{12}$/);
  assert.match(
    String(aliases.snapshot.risk_distribution.by_risk_category.api_token),
    /^hash:[0-9a-f]{12}$/,
  );
});

test('keyCount 仅在 canonical 风险归因快照且为有限非负数时放行', () => {
  const snapshot = redactReportSnapshot({
    riskAttribution: { keyCount: 3 },
    summary: { riskAttribution: { keyCount: 4 } },
    detail: { keyCount: 5 },
    metrics: { keyCount: 6 },
    fake: { riskAttribution: { keyCount: 7 } },
    risk_attribution: { key_count: 8 },
  }) as any;
  assert.equal(snapshot.riskAttribution.keyCount, 3);
  assert.equal(snapshot.summary.riskAttribution.keyCount, 4);
  for (const value of [
    snapshot.detail.keyCount,
    snapshot.metrics.keyCount,
    snapshot.fake.riskAttribution.keyCount,
    snapshot.risk_attribution.key_count,
  ]) {
    assert.match(String(value), /^hash:[0-9a-f]{12}$/);
  }

  for (const value of ['opaque-key-count', -1, Number.POSITIVE_INFINITY]) {
    const invalid = redactReportSnapshot({ riskAttribution: { keyCount: value } }) as any;
    assert.match(String(invalid.riskAttribution.keyCount), /^hash:[0-9a-f]{12}$/);
  }
  const input = redactReportJson({ riskAttribution: { keyCount: 3 } }) as any;
  assert.match(String(input.riskAttribution.keyCount), /^hash:[0-9a-f]{12}$/);
});

test('BuiltReport、PDF 与 HTML model 的快照出口不含秘密且保留图表类型', () => {
  const outputSecret = 'sk-built-report-secret-1234567890';
  const built = buildTaskReport(redactReportInputData(reportInput()));
  built.summary.aiJudgment = {
    source: 'llm',
    configured: true,
    posture: `态势 ${outputSecret} <MASKED>`,
    topRisks: '凭据泄露',
    remediationPriority: '立即轮换',
    focus: '凭据保护',
  };

  const safeBuilt = redactReportSnapshot(built) as BuiltReport;
  const pdfModel = buildReportPdfDoc(safeBuilt);
  const htmlModel = buildReportHtmlModel(safeBuilt);
  const serialized = JSON.stringify({ safeBuilt, pdfModel, htmlModel });
  assert.doesNotMatch(serialized, new RegExp(outputSecret));
  assert.doesNotMatch(serialized, /<MASKED>/);
  assert.match(serialized, /hash:[a-f0-9]{12}|内容已.*脱敏/);
  assert.equal(typeof safeBuilt.summary.charts.verdict[0]?.key, 'string');
  assert.equal(typeof safeBuilt.summary.charts.verdict[0]?.value, 'number');
  assert.equal(typeof safeBuilt.summary.securityScore.score, 'number');
});
