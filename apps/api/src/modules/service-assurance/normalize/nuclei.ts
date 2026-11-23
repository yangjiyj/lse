import { createHash } from 'node:crypto';
import { getServiceAssurancePlannedChecks } from '@lse/shared';
import type {
  AssuranceEvidenceLevel,
  ServiceAssuranceExecutionRecord,
  AssurancePriority,
  ServiceAssuranceMode,
  ServiceAssuranceNotice,
  Severity,
} from '@lse/shared';
import { isRecord, redactString } from '../../../lib/redact.js';
import type {
  NucleiNormalizationResult,
  ServiceAssetDraft,
  ServiceComponentDraft,
  ServiceEvidenceDraft,
  VulnerabilityAssessmentDraft,
} from '../contracts.js';

export interface NucleiNormalizationOptions {
  mode: ServiceAssuranceMode;
  authorizationConfirmed: boolean;
  completed: boolean;
  rulesetStatus: 'CURRENT' | 'STALE' | 'NOT_READY';
  execution?: ServiceAssuranceExecutionRecord;
}

interface NucleiEvent {
  templateId: string;
  info: Record<string, unknown>;
  matcherName: string | null;
  type: string;
  host: string | null;
  matchedAt: string | null;
  extractedResults: string[];
  request: string | null;
  response: string | null;
  ip: string | null;
}

const MAX_SUMMARY_LENGTH = 8_000;
const SENSITIVE_HTTP_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token):.*$/gim;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableKey(parts: Array<string | null>): string {
  return hash(parts.map((part) => part ?? '').join('\u0000'));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metadata(info: Record<string, unknown>): Record<string, unknown> {
  return isRecord(info.metadata) ? info.metadata : {};
}

function classification(info: Record<string, unknown>): Record<string, unknown> {
  return isRecord(info.classification) ? info.classification : {};
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const found = text(item);
    if (found) return found;
  }
  return null;
}

function parseEvent(value: unknown): NucleiEvent | null {
  if (!isRecord(value) || !isRecord(value.info)) return null;
  const templateId = text(value['template-id']);
  const type = text(value.type);
  if (!templateId || !type) return null;
  return {
    templateId,
    info: value.info,
    matcherName: text(value['matcher-name']),
    type,
    host: text(value.host) ?? text(value.url),
    matchedAt: text(value['matched-at']),
    extractedResults: Array.isArray(value['extracted-results'])
      ? value['extracted-results'].flatMap((item) => (typeof item === 'string' ? [item] : []))
      : [],
    request: text(value.request),
    response: text(value.response),
    ip: text(value.ip),
  };
}

function normalizeSeverity(value: unknown): Severity | null {
  const normalized = text(value)?.toLowerCase();
  if (normalized === 'info' || normalized === 'informational') return 'INFO';
  if (normalized === 'low') return 'LOW';
  if (normalized === 'medium') return 'MEDIUM';
  if (normalized === 'high') return 'HIGH';
  if (normalized === 'critical') return 'CRITICAL';
  return null;
}

function priorityFor(
  severity: Severity | null,
  evidenceLevel: AssuranceEvidenceLevel,
): AssurancePriority {
  if (evidenceLevel === 'LEAD' || severity === null) return 'UNKNOWN';
  if (severity === 'CRITICAL') return 'P0';
  if (severity === 'HIGH') return 'P1';
  if (severity === 'MEDIUM') return 'P2';
  return 'P3';
}

function redactTranscript(value: string | null): string | null {
  if (!value) return null;
  const redacted = redactString(value).replace(
    SENSITIVE_HTTP_HEADER,
    (_line, header: string) => `${header}: [REDACTED]`,
  );
  return redacted.length > MAX_SUMMARY_LENGTH
    ? `${redacted.slice(0, MAX_SUMMARY_LENGTH)}...`
    : redacted;
}

function assetFrom(event: NucleiEvent): ServiceAssetDraft {
  const rawAddress = event.host ?? event.matchedAt ?? 'unknown-target';
  let protocol: string | null = null;
  let host: string | null = null;
  let port: number | null = null;
  let normalizedAddress = rawAddress;
  try {
    const url = new URL(rawAddress);
    protocol = url.protocol.replace(/:$/, '');
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    normalizedAddress = `${url.protocol}//${url.host}`;
  } catch {
    host = event.ip;
  }
  const assetKey = stableKey([normalizedAddress]);
  return {
    customerName: host ?? normalizedAddress,
    normalizedAddress,
    protocol,
    host,
    port,
    title: null,
    assetKey,
  };
}

function evidenceLevelFor(
  event: NucleiEvent,
  options: NucleiNormalizationOptions,
): { level: AssuranceEvidenceLevel; unauthorizedActive: boolean } {
  const declared = text(metadata(event.info)['lse-evidence'])?.toLowerCase();
  if (declared === 'active') {
    const authorized = options.mode === 'DEEP' && options.authorizationConfirmed;
    return { level: authorized ? 'ACTIVE_VERIFIED' : 'LEAD', unauthorizedActive: !authorized };
  }
  if (declared === 'config') return { level: 'CONFIG_MATCH', unauthorizedActive: false };
  if (declared === 'version') return { level: 'VERSION_MATCH', unauthorizedActive: false };
  return { level: 'LEAD', unauthorizedActive: false };
}

function componentFrom(
  event: NucleiEvent,
  assetKey: string,
  evidenceLevel: AssuranceEvidenceLevel,
): ServiceComponentDraft | null {
  const meta = metadata(event.info);
  const rawName = text(meta['component-name']) ?? text(meta.product);
  if (!rawName) return null;
  const name = rawName.toLowerCase() === 'triton' ? 'NVIDIA Triton 推理服务' : rawName;
  const version = text(meta['component-version']);
  const componentKey = stableKey([assetKey, name, version]);
  return {
    assetKey,
    name,
    vendor: text(meta.vendor),
    version,
    purl: text(meta.purl),
    cpe: text(classification(event.info).cpe),
    hashes: null,
    source: 'REMOTE_FINGERPRINT',
    confidence: evidenceLevel === 'LEAD' ? 0.35 : 0.9,
    evidenceLevel,
    componentKey,
  };
}

function customerText(event: NucleiEvent, key: string, fallback: string): string {
  return text(metadata(event.info)[key]) ?? fallback;
}

function normalizeEvent(
  event: NucleiEvent,
  options: NucleiNormalizationOptions,
): {
  asset: ServiceAssetDraft;
  component: ServiceComponentDraft | null;
  assessment: VulnerabilityAssessmentDraft;
  evidence: ServiceEvidenceDraft;
  unauthorizedActive: boolean;
} {
  const asset = assetFrom(event);
  const evidenceDecision = evidenceLevelFor(event, options);
  const component = componentFrom(event, asset.assetKey, evidenceDecision.level);
  const lead = evidenceDecision.level === 'LEAD';
  const severity = normalizeSeverity(event.info.severity);
  const classInfo = classification(event.info);
  const advisoryId = lead ? null : firstString(classInfo['cve-id']);
  const defaultTitle = lead ? '疑似组件、待核验线索' : (text(event.info.name) ?? '服务配置风险');
  const title = customerText(event, 'customer-title', defaultTitle);
  const defaultReason = lead
    ? '仅识别到组件名称，未取得版本或主动验证证据，当前不能确认对应漏洞影响。'
    : '目标响应满足固定安全规则的配置判定条件。';
  const reason = customerText(event, 'customer-summary', defaultReason);
  const impactStatus = lead ? 'UNDER_INVESTIGATION' : 'AFFECTED';
  const confidence = lead ? 0.35 : evidenceDecision.level === 'ACTIVE_VERIFIED' ? 0.98 : 0.9;
  const assessmentKey = stableKey([
    asset.assetKey,
    component?.componentKey ?? null,
    advisoryId,
    event.templateId,
    evidenceDecision.level,
  ]);
  const requestSummary = redactTranscript(event.request);
  const responseSummary = redactTranscript(event.response);
  const contentSha256 = hash(
    JSON.stringify({
      templateId: event.templateId,
      matcherName: event.matcherName,
      matchedAt: event.matchedAt,
      extractedResults: event.extractedResults,
      requestSummary,
      responseSummary,
    }),
  );
  const assessment: VulnerabilityAssessmentDraft = {
    assetKey: asset.assetKey,
    componentKey: component?.componentKey ?? null,
    advisoryId,
    title,
    severity,
    cvss: numberValue(classInfo['cvss-score']),
    fixedVersion: text(metadata(event.info)['fixed-version']),
    kev: null,
    epss: numberValue(classInfo['epss-score']),
    impactStatus,
    evidenceLevel: evidenceDecision.level,
    confidence,
    priority: priorityFor(severity, evidenceDecision.level),
    reason,
    remediation: text(event.info.remediation),
    assessmentKey,
  };
  return {
    asset,
    component,
    assessment,
    unauthorizedActive: evidenceDecision.unauthorizedActive,
    evidence: {
      assessmentKey,
      componentKey: component?.componentKey ?? null,
      evidenceType: lead ? 'COMPONENT_LEAD' : 'RULE_MATCH',
      sourceTool: 'nuclei',
      ruleId: event.templateId,
      ruleSummary: text(event.info.name),
      matchedLocation: event.matchedAt,
      extractedValue: event.extractedResults.length ? event.extractedResults.join(', ') : null,
      customerSummary: reason,
      requestSummary,
      responseSummary,
      contentSha256,
      visibility: 'TECHNICAL',
    },
  };
}

function pushNotice(notices: ServiceAssuranceNotice[], code: string, message: string): void {
  if (notices.some((notice) => notice.code === code)) return;
  notices.push({ code, message });
}

export function normalizeNucleiJsonl(
  jsonl: string,
  options: NucleiNormalizationOptions,
): NucleiNormalizationResult {
  const notices: ServiceAssuranceNotice[] = [];
  const planned = getServiceAssurancePlannedChecks(options.mode, 'ENDPOINT');
  const observed = options.execution;
  const checks = planned.map((check) => {
    const matches = observed?.checks.filter((item) => item.id === check.id) ?? [];
    const actual = matches.length === 1 ? matches[0] : undefined;
    if (
      !actual ||
      (actual.status === 'COMPLETED' && (actual.requestCount === null || actual.requestCount === 0))
    ) {
      return {
        id: check.id,
        label: check.label,
        status: 'UNKNOWN' as const,
        requestCount: null,
        detail: '未取得该检查的实际请求执行证据，不能确认该项已完成。',
      };
    }
    return { ...actual, label: check.label };
  });
  const execution: ServiceAssuranceExecutionRecord = {
    checks,
    requestCount: observed?.requestCount ?? null,
  };
  if (
    checks.some((check) => check.status !== 'COMPLETED') ||
    observed?.checks.length !== planned.length ||
    !observed ||
    observed.requestCount === null ||
    checks.some((check) => check.requestCount === null) ||
    checks.reduce((sum, check) => sum + (check.requestCount ?? 0), 0) !== observed.requestCount
  ) {
    pushNotice(
      notices,
      'SERVICE_ASSURANCE_EXECUTION_UNVERIFIED',
      '部分检查缺少完整的实际执行证据，请查看逐项执行记录。',
    );
  }
  const parsed: NucleiEvent[] = [];
  let invalidLineCount = 0;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = parseEvent(JSON.parse(line));
      if (event) parsed.push(event);
      else invalidLineCount += 1;
    } catch {
      invalidLineCount += 1;
    }
  }

  if (invalidLineCount > 0) {
    pushNotice(
      notices,
      'SERVICE_ASSURANCE_OUTPUT_PARTIAL',
      '部分核验结果无法解析，本次覆盖不完整。',
    );
  }
  if (!options.completed) {
    pushNotice(
      notices,
      'SERVICE_ASSURANCE_SCAN_INCOMPLETE',
      '核验未完整执行，结论仅适用于已完成检查项。',
    );
  }
  if (options.rulesetStatus === 'STALE') {
    pushNotice(notices, 'SERVICE_ASSURANCE_RULESET_STALE', '规则库已过期，本次覆盖不完整。');
  }
  if (options.rulesetStatus === 'NOT_READY') {
    pushNotice(notices, 'SERVICE_ASSURANCE_RULESET_NOT_READY', '安全检查模式尚未就绪。');
  }

  const normalized = parsed.map((event) => normalizeEvent(event, options));
  if (normalized.some((item) => item.unauthorizedActive)) {
    pushNotice(
      notices,
      'SERVICE_ASSURANCE_ACTIVE_NOT_AUTHORIZED',
      '检测到未获授权的主动核验证据，已降级为待核验线索。',
    );
  }

  const assets = [...new Map(normalized.map((item) => [item.asset.assetKey, item.asset])).values()];
  const components = [
    ...new Map(
      normalized.flatMap((item) =>
        item.component ? [[item.component.componentKey, item.component] as const] : [],
      ),
    ).values(),
  ];
  const assessments = normalized.map((item) => item.assessment);
  const evidence = normalized.map((item) => item.evidence);
  const coverageStatus =
    options.rulesetStatus === 'NOT_READY'
      ? 'NOT_READY'
      : notices.length > 0
        ? 'INCOMPLETE'
        : 'COMPLETE';
  const confirmed = assessments.filter((item) => item.impactStatus === 'AFFECTED').length;
  const underInvestigation = assessments.filter(
    (item) => item.impactStatus === 'UNDER_INVESTIGATION',
  ).length;

  return {
    mode: options.mode,
    execution,
    coverageStatus,
    invalidLineCount,
    eventsProcessed: parsed.length,
    assets,
    components,
    assessments,
    evidence,
    notices,
    customerSummary: {
      confirmed,
      underInvestigation,
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
