/**
 * CI 导出格式化（纯函数）：把评估任务结果转成 JUnit XML / SARIF 2.1.0 / JSON。
 *
 * 安全约束：只输出判定摘要，绝不输出模型的完整回答（response）；
 * 摘要先经平台脱敏函数处理，再截断到 SUMMARY_MAX_CHARS 个字符。
 */
import { redactString } from '../../lib/redact.js';
import { PRODUCT_FULL_NAME } from '../../lib/product-name.js';

export const SUMMARY_MAX_CHARS = 300;
export const EXPORT_FORMATS = ['junit', 'sarif', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type CaseVerdict = 'PASS' | 'FAIL' | 'ERROR' | 'UNKNOWN';

export interface ExportFrameworkRef {
  framework: string;
  entryId: string;
  entryName: string;
}

export interface ExportCase {
  resultId: string;
  questionId: string;
  /** 风险类别（题目分类，缺省取发现的风险类别）。 */
  category: string;
  /** 题目标题（题干的短摘录，已脱敏）。 */
  title: string;
  verdict: CaseVerdict;
  severity: string | null;
  /** 判定理由摘要：已脱敏并截断，不含模型完整回答。 */
  summary: string;
  engines: string[];
  frameworks: ExportFrameworkRef[];
  latencyMs: number | null;
}

export interface ExportGate {
  gateId: string;
  gateName: string;
  passed: boolean;
  reasons: string[];
  metrics: unknown;
  evaluatedAt: string;
}

export interface ExportTaskInfo {
  id: string;
  name: string;
  status: string;
  modelTargetName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalQuestions: number;
  passedCount: number;
  failedCount: number;
  errorCount: number;
}

export interface ExportBundle {
  task: ExportTaskInfo;
  gates: ExportGate[];
  cases: ExportCase[];
  generatedAt: string;
}

/** 脱敏后截断（按码点，避免截断代理对）；超长以省略号结尾。 */
export function safeSummary(text: string | null | undefined, max = SUMMARY_MAX_CHARS): string {
  if (!text) return '';
  const redacted = redactString(String(text)).replace(/\s+/g, ' ').trim();
  const chars = Array.from(redacted);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : redacted;
}

export function mapSeverityToSarifLevel(
  severity: string | null | undefined,
): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'error';
    case 'MEDIUM':
      return 'warning';
    default:
      return 'note';
  }
}

// ---------------------------------------------------------------- XML

/** 去掉 XML 1.0 不允许的控制字符并转义。 */
export function xmlEscape(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildJunit(bundle: ExportBundle): string {
  const byCategory = new Map<string, ExportCase[]>();
  for (const c of bundle.cases) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const t = bundle.task;
  const allFail = bundle.cases.filter((c) => c.verdict === 'FAIL').length;
  const allErr = bundle.cases.filter((c) => c.verdict === 'ERROR').length;
  const allSkip = bundle.cases.filter((c) => c.verdict === 'UNKNOWN').length;
  lines.push(
    `<testsuites name="${xmlEscape(t.name)}" tests="${bundle.cases.length}" failures="${allFail}" errors="${allErr}" skipped="${allSkip}">`,
  );
  for (const [category, cases] of [...byCategory.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const failures = cases.filter((c) => c.verdict === 'FAIL').length;
    const errors = cases.filter((c) => c.verdict === 'ERROR').length;
    const skipped = cases.filter((c) => c.verdict === 'UNKNOWN').length;
    lines.push(
      `  <testsuite name="${xmlEscape(category)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" timestamp="${xmlEscape(t.finishedAt ?? bundle.generatedAt)}">`,
    );
    lines.push('    <properties>');
    lines.push(`      <property name="taskId" value="${xmlEscape(t.id)}"/>`);
    lines.push('    </properties>');
    for (const c of cases) {
      const time = c.latencyMs != null ? (c.latencyMs / 1000).toFixed(3) : '0';
      const attrs = `classname="${xmlEscape(category)}" name="${xmlEscape(`${c.questionId.slice(0, 8)} ${c.title}`.trim())}" time="${time}"`;
      const severity = c.severity ? `严重度：${c.severity}。` : '';
      if (c.verdict === 'PASS') {
        lines.push(`    <testcase ${attrs}/>`);
      } else if (c.verdict === 'FAIL') {
        const msg = `${severity}${c.summary || '判定未通过'}`;
        lines.push(`    <testcase ${attrs}>`);
        lines.push(
          `      <failure message="${xmlEscape(msg)}" type="${xmlEscape(c.severity ?? 'FAIL')}">${xmlEscape(msg)}</failure>`,
        );
        lines.push('    </testcase>');
      } else if (c.verdict === 'ERROR') {
        const msg = c.summary || '调用或判定过程出错';
        lines.push(`    <testcase ${attrs}>`);
        lines.push(
          `      <error message="${xmlEscape(msg)}" type="ERROR">${xmlEscape(msg)}</error>`,
        );
        lines.push('    </testcase>');
      } else {
        lines.push(`    <testcase ${attrs}>`);
        lines.push(
          `      <skipped message="${xmlEscape(`未判定：${c.summary || '暂无可用判定结论'}`)}"/>`,
        );
        lines.push('    </testcase>');
      }
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- SARIF

export function buildSarif(bundle: ExportBundle): Record<string, unknown> {
  const failed = bundle.cases.filter((c) => c.verdict === 'FAIL');
  const ruleIds = [...new Set(failed.map((c) => c.category))].sort();
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: `大模型安全评估风险类别：${id}` },
  }));
  const results = failed.map((c) => ({
    ruleId: c.category,
    ruleIndex: ruleIds.indexOf(c.category),
    level: mapSeverityToSarifLevel(c.severity),
    message: { text: c.summary || `风险类别「${c.category}」判定未通过` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: `lse-task/${bundle.task.id}` },
        },
        logicalLocations: [{ name: c.title || c.questionId, kind: 'member' }],
      },
    ],
    properties: {
      taskId: bundle.task.id,
      questionId: c.questionId,
      resultId: c.resultId,
      severity: c.severity,
      engines: c.engines,
      owasp: c.frameworks.filter((f) => f.framework.startsWith('OWASP')),
      atlas: c.frameworks.filter((f) => f.framework === 'ATLAS'),
      frameworks: c.frameworks,
    },
  }));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: `LSE ${PRODUCT_FULL_NAME}`,
            informationUri: 'https://example.invalid/lse',
            rules,
          },
        },
        automationDetails: { id: `lse/${bundle.task.id}` },
        results,
        properties: {
          taskId: bundle.task.id,
          taskName: bundle.task.name,
          gates: bundle.gates.map((g) => ({
            gateId: g.gateId,
            gateName: g.gateName,
            passed: g.passed,
          })),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------- JSON

export function buildJsonExport(bundle: ExportBundle): Record<string, unknown> {
  const gatePassed = bundle.gates.length === 0 ? null : bundle.gates.every((g) => g.passed);
  return {
    generatedAt: bundle.generatedAt,
    task: bundle.task,
    gate: { evaluated: bundle.gates.length > 0, passed: gatePassed, items: bundle.gates },
    findings: bundle.cases.filter((c) => c.verdict === 'FAIL'),
    summary: {
      total: bundle.cases.length,
      passed: bundle.cases.filter((c) => c.verdict === 'PASS').length,
      failed: bundle.cases.filter((c) => c.verdict === 'FAIL').length,
      error: bundle.cases.filter((c) => c.verdict === 'ERROR').length,
      unknown: bundle.cases.filter((c) => c.verdict === 'UNKNOWN').length,
    },
    notice: `为避免有害内容外泄，导出不含模型完整回答，判定摘要已脱敏并截断到 ${SUMMARY_MAX_CHARS} 字。`,
  };
}

export const FORMAT_META: Record<ExportFormat, { contentType: string; ext: string }> = {
  junit: { contentType: 'application/xml; charset=utf-8', ext: 'xml' },
  sarif: { contentType: 'application/sarif+json; charset=utf-8', ext: 'sarif' },
  json: { contentType: 'application/json; charset=utf-8', ext: 'json' },
};
