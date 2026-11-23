import { hashSensitive, redactString } from '../../lib/redact.js';
import type { ReportInputData } from './report-builder.js';

export const REPORT_MASKED_DISPLAY_NOTE = '（内容已在网关侧脱敏，无可展示原文）';

type ReportRedactionMode = 'input' | 'snapshot';

const ARRAY_PATH_SEGMENT = '[]';
const CHART_KEY_SERIES = new Set([
  'severity',
  'verdict',
  'riskCategory',
  'riskDomain',
  'engineStatus',
  'byLanguage',
]);
const VALID_SUPPRESSION_KEY_RE = /^[0-9a-f]{24}$/i;
const SENSITIVE_REPORT_FIELDS = new Set([
  'key',
  'keycount',
  'businesskey',
  'secretegress',
  'suppressionkey',
  'authorization',
  'token',
  'secret',
  'password',
  'passphrase',
  'cookie',
  'setcookie',
  'jwt',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'bearer',
  'canary',
]);
const DYNAMIC_COUNT_MAP_FIELDS = new Set([
  'byRiskCategory',
  'byRiskDomain',
  'bySeverity',
  'verdictCounts',
  'verdictDistribution',
  'severityDistribution',
  'severityCounts',
]);
const CREDENTIAL_FIELD_RE =
  /(?:authorization|token|secret|password|passphrase|credential|credentials|cookie|setcookie|jwt|session|sessionid|bearer|canary|(?:api|access|secret|private)key)(?:value|header|hash|pem|id)?$/;

function normalizeReportFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveReportField(key: string): boolean {
  const normalized = normalizeReportFieldName(key);
  if (!normalized) return false;
  return SENSITIVE_REPORT_FIELDS.has(normalized) || CREDENTIAL_FIELD_RE.test(normalized);
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function matchesCanonicalPath(path: string[], expected: string[]): boolean {
  if (path.length !== expected.length) return false;
  return expected.every((segment, index) => path[index] === segment);
}

function isDynamicCountMapPath(mode: ReportRedactionMode, path: string[]): boolean {
  const field = path.at(-1) ?? '';
  if (
    !DYNAMIC_COUNT_MAP_FIELDS.has(field) ||
    path.some((segment) => normalizeReportFieldName(segment).includes('detail'))
  ) {
    return false;
  }

  if (mode === 'input') {
    return (
      (path.length === 1 && field === 'verdictCounts') ||
      (path.length === 2 && path[0] === 'contrast')
    );
  }

  // 调用者可能直接传 summary/listSummary/riskDistribution，因此根级已知 map 合法。
  if (path.length === 1) return true;

  const parent = path.at(-2);
  if (['byRiskCategory', 'byRiskDomain', 'bySeverity'].includes(field)) {
    if (parent !== 'riskDistribution') return false;
    return (
      path.length === 2 || (path.length === 3 && ['summary', 'listSummary'].includes(path[0] ?? ''))
    );
  }
  if (['verdictDistribution', 'severityDistribution'].includes(field)) {
    return path.length === 2 && ['summary', 'listSummary'].includes(path[0] ?? '');
  }
  return (
    field === 'severityCounts' &&
    path.length === 3 &&
    path[0] === 'points' &&
    path[1] === ARRAY_PATH_SEGMENT
  );
}

function isCanonicalChartKeyPath(path: string[]): boolean {
  const rootChart = path.length === 4 && path[0] === 'charts';
  const summaryChart = path.length === 5 && path[0] === 'summary' && path[1] === 'charts';
  if (!rootChart && !summaryChart) return false;

  return (
    path.at(-2) === ARRAY_PATH_SEGMENT &&
    path.at(-1) === 'key' &&
    CHART_KEY_SERIES.has(path.at(-3) ?? '')
  );
}

function isAllowedReportValue(mode: ReportRedactionMode, path: string[], value: unknown): boolean {
  if (mode === 'snapshot' && typeof value === 'string' && isCanonicalChartKeyPath(path)) {
    return true;
  }
  if (
    mode === 'input' &&
    typeof value === 'string' &&
    VALID_SUPPRESSION_KEY_RE.test(value) &&
    matchesCanonicalPath(path, ['findings', ARRAY_PATH_SEGMENT, 'suppressionKey'])
  ) {
    return true;
  }
  return (
    mode === 'snapshot' &&
    isFiniteNonnegativeNumber(value) &&
    (matchesCanonicalPath(path, ['riskAttribution', 'keyCount']) ||
      matchesCanonicalPath(path, ['summary', 'riskAttribution', 'keyCount']))
  );
}

export function replaceReportMaskedLiteral<T extends string | null | undefined>(text: T): T {
  return (
    typeof text === 'string' && text.includes('<MASKED>')
      ? text.replace(/<MASKED>/g, REPORT_MASKED_DISPLAY_NOTE)
      : text
  ) as T;
}

export function redactReportString<T extends string | null | undefined>(text: T, key = ''): T {
  return (
    typeof text === 'string'
      ? replaceReportMaskedLiteral(
          isSensitiveReportField(key) ? hashSensitive(text) : redactString(text),
        )
      : text
  ) as T;
}

function defineReportField(
  out: Record<string, unknown>,
  requestedKey: string,
  value: unknown,
): void {
  let outputKey = requestedKey;
  if (Object.hasOwn(out, outputKey)) {
    const stem = requestedKey.replace(/#\d+$/, '');
    let suffix = 2;
    while (Object.hasOwn(out, `${stem}#${suffix}`)) suffix += 1;
    outputKey = `${stem}#${suffix}`;
  }

  Object.defineProperty(out, outputKey, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

interface ReportRedactionContext {
  mode: ReportRedactionMode;
  path: string[];
  parentSensitive: boolean;
  skipFieldSensitivity: boolean;
}

function redactReportTree(value: unknown, key: string, context: ReportRedactionContext): unknown {
  if (value instanceof Date) return value;
  const fieldSensitive =
    !context.skipFieldSensitivity &&
    !isAllowedReportValue(context.mode, context.path, value) &&
    isSensitiveReportField(key);
  const sensitive = context.parentSensitive || fieldSensitive;
  if (typeof value === 'string') {
    return redactReportString(value, sensitive ? 'secret' : '');
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return sensitive ? hashSensitive(String(value)) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactReportTree(item, '', {
        mode: context.mode,
        path: [...context.path, ARRAY_PATH_SEGMENT],
        parentSensitive: sensitive,
        skipFieldSensitivity: false,
      }),
    );
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const dynamicCountMap = isDynamicCountMapPath(context.mode, context.path);
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const outputKey = redactReportString(childKey);
      // 动态计数 map 是 Record<string, number>：非法类型直接丢弃，禁止混入报告 schema。
      if (dynamicCountMap && !isFiniteNonnegativeNumber(childValue)) {
        continue;
      }
      const outputValue = redactReportTree(childValue, childKey, {
        mode: context.mode,
        path: [...context.path, childKey],
        parentSensitive: sensitive,
        // 通过 schema 校验后，动态键只作为分类标签；敏感父路径仍会继续传播。
        skipFieldSensitivity: dynamicCountMap,
      });
      defineReportField(out, outputKey, outputValue);
    }
    return out;
  }
  // null、undefined 与 Date 不携带可直接展示的凭据值，保持原始类型。
  return value;
}

function redactReportRoot(value: unknown, key: string, mode: ReportRedactionMode): unknown {
  return redactReportTree(value, key, {
    mode,
    path: key ? [key] : [],
    parentSensitive: false,
    skipFieldSensitivity: false,
  });
}

/** 原始 gather/模型外发的强边界：值模式 + 路径敏感字段及父路径传播。 */
export function redactReportJson(value: unknown, key = ''): unknown {
  return redactReportRoot(value, key, 'input');
}

/** 冻结报告读取边界：按已知快照结构保留图表枚举、计数 map、null 与 Date。 */
export function redactReportSnapshot<T>(value: T): T {
  return redactReportRoot(value, '', 'snapshot') as T;
}

/** gatherReportData 的唯一客户报告出站边界。 */
export function redactReportInputData(data: ReportInputData): ReportInputData {
  return redactReportJson(data) as ReportInputData;
}
