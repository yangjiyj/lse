import { PRODUCT_NAME } from '../../../lib/product-name.js';
import { reportConclusionScopeKindForReportKind } from '../report-conclusion.js';
import {
  buildEndpointSummary,
  endpointPlainText,
  type EndpointTaskSummary,
} from '../../eval-tasks/endpoint-summary.js';
import { buildEndpointClauseView } from '../../../../../../packages/shared/src/endpoint-report-clauses.js';
import type { EndpointReportInput } from '../../../../../../packages/shared/src/endpoint-report-model.js';
import { LINE_BASIS_STATEMENT, basisLines, reportBasesForLines } from '../../../../../../packages/shared/src/standards/index.js';
import type { ReportInputData } from '../report-builder.js';
import { makeSpecializedReport } from './common.js';
import type { ReportKind, SpecializedReport } from './types.js';
const stateLabel = {
  risk: '发现风险',
  review: '待确认',
  clear: '已检查无风险',
  not_checked: '终端没检查',
};
const isolationLabels: Record<string, string> = {
  bwrap: '系统文件隔离（bwrap）',
  'sandbox-exec': '系统沙箱隔离（sandbox-exec）',
  'hook-only': '仅钩子拦截（hook-only），未做系统文件隔离',
  hook_inactive: '防护钩子未生效（hook_inactive），无法确认行为受到管控',
};
const modelRouteLabels: Record<string, string> = {
  vendor: '模型服务商直连（vendor）',
  jjdguard: `经${PRODUCT_NAME}模型防护服务（jjdguard）`,
  unknown: '终端未确认模型路由（unknown）',
};
function clauseSections(summary: EndpointTaskSummary): string[] {
  const view = buildEndpointClauseView(summary as unknown as EndpointReportInput);
  const bases = basisLines(reportBasesForLines(['endpoint'], view.usedClauseIds));
  return [
    '## 评估依据',
    '',
    LINE_BASIS_STATEMENT.endpoint,
    ...bases.bases.map((b) => `- ${b}`),
    '',
    '## 部署使用安全检查清单',
    '',
    `共 ${view.counts.total} 项，测过 ${view.counts.conform + view.counts.nonconform} 项：符合 ${view.counts.conform} 项，不符合 ${view.counts.nonconform} 项；其余 ${view.counts.untested} 项没有测，不能算通过。`,
    ...view.tested.map((r) => `- [${r.stage}] ${r.clause.title}：${r.label}${r.basis ? `（${r.basis}）` : ''}`),
    ...view.untested.map((g) => `- ${g.titles.length} 项${g.reason}：${g.titles.join('；')}`),
    '',
    '## 智能体应用安全 8 项要求（参照在研国标，非现行）',
    '',
    ...view.requirements.map((r) => `- ${r.clause.title}：${r.label}${r.basis ? `（${r.basis}）` : ''}`),
    '',
  ];
}
export function endpointReportContent(summary: EndpointTaskSummary, time: string): string {
  return [
    '# 终端安全检测报告',
    '',
    '## 被测电脑与时间',
    '',
    `电脑：${summary.endpoint.name}`,
    `检测时间：${time}`,
    `最近在线：${summary.endpoint.lastSeenAt || '尚未上报'}`,
    '',
    '## 被测智能体清单',
    '',
    ...(summary.agents.length
      ? summary.agents.map((a) => `- ${a.displayName}，版本：${a.version || '终端尚未上报版本'}`)
      : ['终端尚未上报智能体清单，请确认采集器正常运行后重新检测。']),
    '',
    '## 检测结论',
    '',
    summary.verdictLine,
    ...(summary.inventoryCounts
      ? [
          `技能 ${summary.inventoryCounts.skills} 个，外部工具 ${summary.inventoryCounts.mcpServers} 个。`,
        ]
      : []),
    ...(summary.retestOf ? [`重测来源任务：${summary.retestOf.taskId}`] : []),
    ...(summary.totals ? [`识破：${summary.totals.modelRefused}，被拦截：${summary.totals.controlBlocked}，照做：${summary.totals.allowed}，无效：${summary.totals.invalid}`] : []),
    '',
    ...clauseSections(summary),
    '## 按风险类别查看检查项',
    '',
    ...summary.groups.flatMap((group) => [
      `### ${group.label}`,
      '',
      ...group.items.flatMap((item) => [
        `- ${item.plainTitle}：${stateLabel[item.state]}`,
        `  依据：${item.plainWhy || item.evidence || '尚无可展示的证据。'}`,
        ...(item.state === 'not_checked'
          ? [`  原因：${item.notCheckedReason}`, `  检查办法：${item.howToCheck}`]
          : item.plainFix
            ? [`  建议：${item.plainFix}`]
            : []),
      ]),
    ]),
    '',
    '## 真机场景记录',
    '',
    ...(summary.liveScenarios.length
      ? summary.liveScenarios.flatMap((s, i) => [
          `### 场景 ${i + 1}`,
          '',
          `被测智能体：${s.driver === 'scripted' ? '固定工具调用脚本' : s.agentName || '智能体名称尚未上报'}`,
          ...(s.sampleVersion ? [`样本：${endpointPlainText(s.sampleTitle || s.runtime?.sample_id || s.scenarioId)} · v${s.sampleVersion}`] : []),
          ...(s.sampleDigest ? [`样本摘要：${endpointPlainText(s.sampleDigest)}`] : []),
          ...(s.outcomeLabel ? [`场景结论：${s.outcomeLabel}`] : []),
          ...(s.inducementSource ? [`诱导来源：${endpointPlainText(s.inducementSource)}`] : []),
          ...(typeof s.lureRead === 'boolean' ? [`是否读到诱导内容：${s.lureRead ? '是' : '否'}`] : []),
          ...(s.invalidReason ? [`无效原因：${endpointPlainText(s.invalidReason)}`] : []),
          `隔离方式：${s.isolation ? isolationLabels[s.isolation] || `终端报告的隔离方式（${endpointPlainText(s.isolation)}），平台未识别其保护范围` : '终端尚未上报，不能确认隔离是否生效'}`,
          `模型路由：${s.modelRoute ? modelRouteLabels[s.modelRoute] || `终端报告的模型路由（${endpointPlainText(s.modelRoute)}）` : '终端尚未上报'}`,
          ...(s.executionNotes?.length
            ? [
                '执行说明与告警：',
                ...s.executionNotes.map((note) => `- ${endpointPlainText(note)}`),
              ]
            : []),
          `让它做了什么：${s.whatWeAsked}`,
          `它实际做了什么：${s.whatItDid}`,
          `判定依据：${s.judgement}`,
          `证据摘录：${s.evidenceExcerpt}`,
          '',
        ])
      : summary.mode === 'live'
        ? ['尚未取得本次真机场景记录，当前不能确认执行完成；请查看终端任务状态并重新同步结果。']
        : ['本任务为配置检查，没有执行真机场景。']),
    '',
    '本报告只覆盖本次被测电脑、智能体、配置和检测时间。未检查的项目不能算通过。',
  ].join('\n');
}
/** 终端评估任务出的是终端报告，不论请求哪个报告方向。 */
export function isEndpointReportData(data: ReportInputData): boolean {
  return (
    data.task.modelTarget?.targetType === 'ENDPOINT_AGENT' ||
    data.task.engines.includes('endpoint-agent-eval')
  );
}
export function buildEndpointReport(kind: ReportKind, data: ReportInputData): SpecializedReport {
  const summary =
    data.endpointSummary ??
    buildEndpointSummary({ task: data.task, results: data.results, findings: data.findings });
  const base = makeSpecializedReport({
    kind,
    conclusionScopeKind: reportConclusionScopeKindForReportKind(kind),
    data,
    headline: summary.verdictLine,
    metrics: {},
    sections: [],
  });
  return {
    ...base,
    title: `终端安全检测报告 - ${endpointPlainText(data.task.name)}`,
    content: endpointReportContent(
      summary,
      (data.task.finishedAt ?? data.generatedAt).toISOString(),
    ),
    summary: {
      ...base.summary,
      endpointSummary: {
        ...summary,
        assessedAt: (data.task.finishedAt ?? data.generatedAt).toISOString(),
        ...(data.task.startedAt ? { startedAt: data.task.startedAt.toISOString() } : {}),
      },
      agentTraceSamples: [],
    },
  };
}
