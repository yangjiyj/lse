import { createHash } from 'node:crypto';
import type {
  AssuranceEvidenceLevel,
  AssurancePriority,
  ServiceAssuranceMode,
  Severity,
} from '@lse/shared';
import { isRecord, redactString, SENSITIVE_KEY_RE } from '../../../lib/redact.js';
import type {
  NucleiNormalizationResult,
  ServiceAssetDraft,
  ServiceEvidenceDraft,
  VulnerabilityAssessmentDraft,
} from '../contracts.js';

export interface ZapNormalizationOptions {
  mode: Exclude<ServiceAssuranceMode, 'SBOM'>;
  authorizationConfirmed: boolean;
  completed: boolean;
  rulesetStatus: 'CURRENT' | 'STALE' | 'NOT_READY';
  allowedActiveRuleIds: string[];
}

interface ZapAlert {
  pluginId: string;
  riskCode: string | null;
  alert: string | null;
  uri: string | null;
  method: string | null;
  parameter: string | null;
  evidence: string | null;
}

const PASSIVE_RULE_IDS = new Set([
  '10010',
  '10011',
  '10015',
  '10016',
  '10017',
  '10019',
  '10020',
  '10021',
  '10023',
  '10024',
  '10025',
  '10027',
  '10032',
  '10035',
  '10036',
  '10037',
  '10038',
  '10040',
  '10041',
  '10049',
  '10050',
  '10054',
  '10055',
  '10056',
  '10057',
  '10061',
  '10062',
  '10063',
  '10096',
  '10098',
  '10109',
]);

const RULE_TEXT: Record<string, { title: string; reason: string; remediation: string }> = {
  '10021': {
    title: '响应缺少类型嗅探防护',
    reason: '目标响应未设置明确的内容类型嗅探防护，浏览器可能错误解释响应内容。',
    remediation: '为适用响应设置 X-Content-Type-Options: nosniff，并声明准确的 Content-Type。',
  },
  '40012': {
    title: '响应内容存在未编码反射',
    reason: '经授权的只读核验发现固定探测标记未经适当编码出现在响应中。',
    remediation: '按输出上下文执行编码，并对输入实施类型、长度和字符集约束。',
  },
  '40018': {
    title: '接口参数存在注入风险',
    reason: '经授权的只读核验观察到接口对固定注入探测的异常响应。',
    remediation: '使用参数化查询，限制数据库账户权限，并统一处理错误响应。',
  },
  '6': {
    title: '接口路径处理存在越界风险',
    reason: '经授权的只读核验观察到接口路径边界控制不足。',
    remediation: '规范化路径后执行目录边界校验，拒绝路径穿越序列。',
  },
};

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token):.*$/gim;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableKey(parts: Array<string | null>): string {
  return hash(parts.map((part) => part ?? '').join('\u0000'));
}

function text(value: unknown, maximum = 4_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function redactEvidence(value: string | null): string | null {
  if (!value) return null;
  const redacted = redactString(value).replace(
    SENSITIVE_HEADER,
    (_line, header: string) => header + ': [REDACTED]',
  );
  return redacted.length > 8_000 ? redacted.slice(0, 8_000) + '...' : redacted;
}

function redactUri(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEY_RE.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return redactEvidence(value);
  }
}

function severityForRiskCode(value: string | null): Severity | null {
  if (value === '0') return 'INFO';
  if (value === '1') return 'LOW';
  if (value === '2') return 'MEDIUM';
  if (value === '3') return 'HIGH';
  return null;
}

function priorityFor(
  severity: Severity | null,
  evidenceLevel: AssuranceEvidenceLevel,
): AssurancePriority {
  if (severity === null || evidenceLevel === 'LEAD') return 'UNKNOWN';
  if (severity === 'CRITICAL') return 'P0';
  if (severity === 'HIGH') return 'P1';
  if (severity === 'MEDIUM') return 'P2';
  return 'P3';
}

function parseAlert(value: unknown): ZapAlert | null {
  if (!isRecord(value)) return null;
  const pluginId = text(value.pluginid, 20);
  if (!pluginId || !Array.isArray(value.instances)) return null;
  const instance = value.instances.find(isRecord);
  return {
    pluginId,
    riskCode: text(value.riskcode, 10),
    alert: text(value.alert, 500) ?? text(value.name, 500),
    uri: instance ? text(instance.uri, 2_048) : null,
    method: instance ? text(instance.method, 20) : null,
    parameter: instance ? text(instance.param, 500) : null,
    evidence: instance ? text(instance.evidence, 8_000) : null,
  };
}

function assetFromSite(site: Record<string, unknown>): ServiceAssetDraft {
  const address = text(site['@name'], 2_048) ?? 'API 服务';
  let protocol: string | null = null;
  let host = text(site['@host'], 500);
  let port: number | null = null;
  let normalizedAddress = address;
  try {
    const url = new URL(address);
    protocol = url.protocol.replace(/:$/, '');
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    normalizedAddress = url.protocol + '//' + url.host;
  } catch {
    const parsedPort = Number(text(site['@port'], 10));
    port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null;
  }
  return {
    customerName: host ?? 'API 服务',
    normalizedAddress,
    protocol,
    host,
    port,
    title: null,
    assetKey: stableKey([normalizedAddress]),
  };
}

function normalizeAlert(
  alert: ZapAlert,
  asset: ServiceAssetDraft,
  options: ZapNormalizationOptions,
): { assessment: VulnerabilityAssessmentDraft; evidence: ServiceEvidenceDraft } | null {
  const activeRule = options.allowedActiveRuleIds.includes(alert.pluginId);
  const passiveRule = PASSIVE_RULE_IDS.has(alert.pluginId);
  if (!activeRule && !passiveRule) return null;
  const activeAuthorized = activeRule && options.mode === 'DEEP' && options.authorizationConfirmed;
  const unauthorizedActive = activeRule && !activeAuthorized;
  const evidenceLevel: AssuranceEvidenceLevel = unauthorizedActive
    ? 'LEAD'
    : activeAuthorized
      ? 'ACTIVE_VERIFIED'
      : 'CONFIG_MATCH';
  const severity = unauthorizedActive ? null : severityForRiskCode(alert.riskCode);
  const ruleText = RULE_TEXT[alert.pluginId] ?? {
    title: 'API 安全配置风险',
    reason: '目标响应满足固定安全规则的判定条件。',
    remediation: '根据受影响接口的业务边界补充输入校验、鉴权和安全响应头。',
  };
  const title = unauthorizedActive ? '疑似安全问题、待核验线索' : ruleText.title;
  const reason = unauthorizedActive
    ? '主动核验证据缺少有效授权确认，当前不能形成正式风险。'
    : ruleText.reason;
  const assessmentKey = stableKey([asset.assetKey, alert.pluginId, alert.uri, evidenceLevel]);
  const requestSummary = redactEvidence(
    [alert.method, redactUri(alert.uri), alert.parameter].filter(Boolean).join(' '),
  );
  const responseSummary = redactEvidence(alert.evidence);
  const assessment: VulnerabilityAssessmentDraft = {
    assetKey: asset.assetKey,
    componentKey: null,
    advisoryId: null,
    title,
    severity,
    cvss: null,
    fixedVersion: null,
    kev: null,
    epss: null,
    impactStatus: unauthorizedActive ? 'UNDER_INVESTIGATION' : 'AFFECTED',
    evidenceLevel,
    confidence: unauthorizedActive ? 0.35 : activeAuthorized ? 0.98 : 0.9,
    priority: priorityFor(severity, evidenceLevel),
    reason,
    remediation: unauthorizedActive ? null : ruleText.remediation,
    assessmentKey,
  };
  return {
    assessment,
    evidence: {
      assessmentKey,
      componentKey: null,
      evidenceType: unauthorizedActive
        ? 'SECURITY_LEAD'
        : activeAuthorized
          ? 'ACTIVE_RULE_MATCH'
          : 'CONFIG_RULE_MATCH',
      sourceTool: 'zap',
      ruleId: alert.pluginId,
      ruleSummary: alert.alert,
      matchedLocation: redactUri(alert.uri),
      extractedValue: null,
      customerSummary: reason,
      requestSummary,
      responseSummary,
      contentSha256: hash(
        JSON.stringify({
          pluginId: alert.pluginId,
          requestSummary,
          responseSummary,
        }),
      ),
      visibility: 'TECHNICAL',
    },
  };
}

export function normalizeZapJson(
  rawJson: string,
  options: ZapNormalizationOptions,
): NucleiNormalizationResult {
  let document: unknown;
  try {
    document = JSON.parse(rawJson);
  } catch {
    throw new Error('API 安全核验结果格式无效');
  }
  if (!isRecord(document) || !Array.isArray(document.site)) {
    throw new Error('API 安全核验结果格式无效');
  }

  const assets: ServiceAssetDraft[] = [];
  const assessments: VulnerabilityAssessmentDraft[] = [];
  const evidence: ServiceEvidenceDraft[] = [];
  const notices: Array<{ code: string; message: string }> = [];
  let invalidLineCount = 0;
  let rejectedRuleCount = 0;

  for (const rawSite of document.site) {
    if (!isRecord(rawSite) || !Array.isArray(rawSite.alerts)) {
      invalidLineCount += 1;
      continue;
    }
    const asset = assetFromSite(rawSite);
    assets.push(asset);
    for (const rawAlert of rawSite.alerts) {
      const alert = parseAlert(rawAlert);
      if (!alert) {
        invalidLineCount += 1;
        continue;
      }
      const normalized = normalizeAlert(alert, asset, options);
      if (!normalized) {
        rejectedRuleCount += 1;
        continue;
      }
      assessments.push(normalized.assessment);
      evidence.push(normalized.evidence);
    }
  }

  if (invalidLineCount > 0) {
    notices.push({
      code: 'SERVICE_ASSURANCE_OUTPUT_PARTIAL',
      message: '部分 API 核验结果无法解析，本次覆盖不完整。',
    });
  }
  if (rejectedRuleCount > 0) {
    notices.push({
      code: 'SERVICE_ASSURANCE_RULE_NOT_ALLOWED',
      message: '结果包含未在固定规则集内的检查项，已拒绝纳入结论。',
    });
  }
  if (!options.completed) {
    notices.push({
      code: 'SERVICE_ASSURANCE_SCAN_INCOMPLETE',
      message: '核验未完整执行，结论仅适用于已完成检查项。',
    });
  }
  if (options.rulesetStatus === 'STALE') {
    notices.push({
      code: 'SERVICE_ASSURANCE_RULESET_STALE',
      message: '规则库已过期，本次覆盖不完整。',
    });
  }
  if (options.rulesetStatus === 'NOT_READY') {
    notices.push({
      code: 'SERVICE_ASSURANCE_RULESET_NOT_READY',
      message: '当前核验模式尚未就绪。',
    });
  }
  if (
    assessments.some(
      (assessment) =>
        assessment.evidenceLevel === 'LEAD' && options.allowedActiveRuleIds.length > 0,
    )
  ) {
    notices.push({
      code: 'SERVICE_ASSURANCE_ACTIVE_NOT_AUTHORIZED',
      message: '主动核验缺少有效授权，相关结果已降级为待核验线索。',
    });
  }

  const coverageStatus =
    options.rulesetStatus === 'NOT_READY'
      ? 'NOT_READY'
      : notices.length > 0
        ? 'INCOMPLETE'
        : 'COMPLETE';
  const dedupedAssets = [...new Map(assets.map((asset) => [asset.assetKey, asset])).values()];
  return {
    mode: options.mode,
    coverageStatus,
    invalidLineCount,
    eventsProcessed: assessments.length,
    assets: dedupedAssets,
    components: [],
    assessments,
    evidence,
    notices,
    customerSummary: {
      confirmed: assessments.filter((item) => item.impactStatus === 'AFFECTED').length,
      underInvestigation: assessments.filter((item) => item.impactStatus === 'UNDER_INVESTIGATION')
        .length,
      notAffected: 0,
      fixed: 0,
      incomplete: coverageStatus !== 'COMPLETE',
      statusMessage:
        coverageStatus === 'COMPLETE'
          ? '核验已完成。'
          : coverageStatus === 'NOT_READY'
            ? '当前模式尚未就绪。'
            : '核验未完成或覆盖不完整。',
    },
  };
}
