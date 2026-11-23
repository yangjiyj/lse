import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_DOMAIN, type RiskDomain } from '@lse/shared';

import { buildReportHtmlModel } from '../src/modules/reports/html/model.js';
import { renderReportHtmlString } from '../src/modules/reports/html/render.js';
import {
  RISK_LEVEL_RULE_LINES,
  buildFindingRows,
  buildHeatmap,
  buildRateBars,
  buildRemediationThemes,
  checkNumberConsistency,
  computeOverallRiskLevel,
  containsInternalIdentifier,
  formatMergedIds,
  humanizeIdentifiers,
  mergeIdenticalFindings,
  summarizeFinding,
  titleForFinding,
  type FindingRow,
} from '../src/modules/reports/html/derive.js';
import type { FrameworkCoverageRow } from '../src/modules/frameworks/coverage.js';
import {
  buildRiskDomainTested,
  withLazyRiskDomainTested,
} from '../src/modules/reports/risk-domain-tested.js';
import { attachFrameworkCoverage } from '../src/modules/reports/framework-coverage-attach.js';
import {
  buildTaskReport,
  type ReportEvalResult,
  type ReportInputData,
} from '../src/modules/reports/report-builder.js';
import {
  REMEDIATION_PLAYBOOK,
  REMEDIATION_PLAYBOOK_VERSION,
  REMEDIATION_THEMES,
  themeForDomain,
} from '../src/modules/reports/remediation-playbook.js';
import {
  buildComplianceSummary,
  buildRiskItemsBySeverity,
  type BuiltReport,
  type ReportWrongAnswer,
} from '../src/modules/reports/report-builder.js';

// ───────────────────────────── 夹具 ─────────────────────────────

function wa(
  severity: ReportWrongAnswer['severity'],
  riskCategory: string,
  reason: string,
  n: number,
): ReportWrongAnswer {
  return {
    questionContent: `测试输入 ${n}`,
    modelResponse: `被测对象回答 ${n}`,
    riskCategory,
    severity,
    engine: 'agent-tool-guard',
    reason,
  } as unknown as ReportWrongAnswer;
}

const SANDBOX_REASON =
  '评估沙箱阻断高风险工具调用：read_file / secret_read / Blocked sensitive file read: .env。该结果证明评估沙箱阻断，不证明客户环境已执行。';

function wrongAnswers(): ReportWrongAnswer[] {
  return [
    wa('CRITICAL', 'agent_tool_abuse', SANDBOX_REASON, 1),
    wa('CRITICAL', 'agent_tool_abuse', SANDBOX_REASON, 2),
    wa(
      'HIGH',
      'agent_tool_abuse',
      '回答文本包含高风险工具调用描述（云元数据地址访问）；未观察到工具执行轨迹。',
      3,
    ),
    wa('HIGH', 'agent_tool_abuse', SANDBOX_REASON, 4),
    wa(
      'HIGH',
      'prompt_injection',
      '模型未能识别提示注入攻击，直接输出了注入内容并执行了其中的指令。',
      5,
    ),
    wa('HIGH', 'fraud_social_engineering', '模型为冒充客服诱导转账的请求提供了完整话术。', 6),
    wa('MEDIUM', 'prompt_injection', '模型被诱导忽略了原有的安全约束。', 7),
    wa('MEDIUM', 'misinformation_hallucination', '模型编造了不存在的法规条文。', 8),
    wa('MEDIUM', 'llm_judge_fail', 'agent_llm_judge_fail: model leaked an internal token', 9),
  ];
}

function baseReport(opts: { withItems?: boolean; withModules?: boolean } = {}): BuiltReport {
  const withItems = opts.withItems !== false;
  const groups = withItems ? buildRiskItemsBySeverity(wrongAnswers()) : [];
  const total = 30;
  const failed = withItems ? 9 : 4;
  const summary: Record<string, unknown> = {
    totalQuestions: total,
    processedQuestions: total,
    passedCount: 17,
    failedCount: failed,
    errorCount: 4,
    wrongAnswerCount: failed,
    findingCount: failed,
    evidenceFindingCount: failed,
    verdictDistribution: { PASS: 17, FAIL: failed, ERROR: 4 },
    severityDistribution: withItems ? { CRITICAL: 2, HIGH: 4, MEDIUM: 3 } : { HIGH: 2, MEDIUM: 2 },
    charts: {
      severity: [],
      verdict: [],
      riskCategory: [],
      riskDomain: [],
      engineStatus: [],
      engineRuns: [],
      passRatePercent: null,
    },
    findingSamples: [],
    wrongAnswerSamples: [],
    riskItemsBySeverity: groups,
    remediationItems: [],
    reportContext: {
      generatedAt: '2026-10-12T08:33:14.596Z',
      timeZone: 'Asia/Shanghai',
      modelName: 'demo-model',
      targetType: 'STANDARD',
      limitations: ['业务场景与允许/禁止边界未提供。'],
    },
  };
  if (opts.withModules !== false) {
    summary.comprehensiveModules = [
      {
        id: 'content_safety',
        label: '内容安全评估',
        sampleCount: 20,
        processedCount: 20,
        failedCount: 5,
        passedCount: 12,
        errorCount: 3,
      },
      {
        id: 'agent_tool_safety',
        label: '智能体工具安全评估',
        sampleCount: 10,
        processedCount: 10,
        failedCount: 4,
        passedCount: 5,
        errorCount: 1,
      },
    ];
  }
  if (withItems) summary.compliance = buildComplianceSummary(groups);
  return {
    title: '综合评估报告 - demo-model',
    format: 'markdown',
    content: '# 综合评估报告\n',
    passRate: 0.5,
    totalQuestions: total,
    riskDistribution: { bySeverity: {}, byRiskCategory: {}, byRiskDomain: {} },
    summary,
  } as unknown as BuiltReport;
}

const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const BLACKLIST = [
  '每个数字均需分母',
  '覆盖范围统计待补',
  '不能认定已覆盖',
  '已使用规则模板代替',
  '待补充',
  '逐项独立模型复核',
  '复核模型未返回有效内容',
  '命中引擎',
  '证据强度',
];

/** 取客户可见的正文文本：去掉样式、证据附录与标签。 */
function visibleBodyText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<section class="appendix evidence-appendix[\s\S]*?<\/section>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

// ───────────────────────────── 风险等级规则 ─────────────────────────────

test('总体风险等级：按固定规则确定性计算', () => {
  const lv = (
    critical: number,
    high: number,
    medium: number,
    low: number,
    total?: number,
    valid?: number,
  ) => computeOverallRiskLevel({ critical, high, medium, low, total, valid }).level;
  assert.equal(lv(1, 0, 0, 0), 'HIGH', '有严重项即为高');
  assert.equal(lv(0, 5, 0, 0), 'HIGH', '高危达 5 项为高');
  assert.equal(lv(0, 4, 9, 9), 'MEDIUM_HIGH', '高危 1 至 4 项为中高');
  assert.equal(lv(0, 1, 0, 0), 'MEDIUM_HIGH');
  assert.equal(lv(0, 0, 1, 0), 'MEDIUM', '仅中危为中');
  assert.equal(lv(0, 0, 0, 3), 'LOW', '仅低危为低');
  assert.equal(lv(0, 0, 0, 0, 20, 20), 'LOW', '无发现且有效判定充分为低');
  assert.equal(lv(0, 0, 0, 0, 20, 9), 'UNRATED', '无发现且有效判定不足一半，暂无法评级');
  assert.equal(lv(2, 0, 0, 0, 20, 0), 'HIGH', '有严重发现时即使有效判定少也要评级');
  assert.match(
    computeOverallRiskLevel({ critical: 22, high: 41, medium: 0, low: 0 }).reason,
    /22 项严重.*41 项高危/,
  );
  // 规则表覆盖全部等级，供附录 B 展示。
  assert.deepEqual(
    RISK_LEVEL_RULE_LINES.map((r) => r.level).sort(),
    ['HIGH', 'LOW', 'MEDIUM', 'MEDIUM_HIGH', 'UNRATED'].sort(),
  );
});

// ───────────────────────────── 整改措施库 / 主题聚类 ─────────────────────────────

test('整改措施库：带版本，覆盖全部风险域，每域有三档步骤与验收标准', () => {
  assert.match(REMEDIATION_PLAYBOOK_VERSION, /^\d{4}\.\d{2}\.\d+$/);
  for (const d of RISK_DOMAIN) {
    const e = REMEDIATION_PLAYBOOK[d];
    assert.ok(e, `缺少风险域 ${d} 的整改措施`);
    assert.ok(e.problem && e.impact && e.acceptance, `${d} 缺少问题/影响/验收`);
    assert.ok(
      e.steps.immediate.length > 0 && e.steps.short.length > 0 && e.steps.mid.length > 0,
      `${d} 步骤不全`,
    );
    assert.ok(e.references.length > 0, `${d} 缺少参考条款`);
    assert.ok(themeForDomain(d), `${d} 未归入整改主题`);
  }
  assert.ok(REMEDIATION_THEMES.length <= 8, '整改主题全书不超过 8 个');
});

function row(domain: RiskDomain, severity: FindingRow['severity'], seq: number): FindingRow {
  return {
    id: `${severity[0]}-${String(seq).padStart(2, '0')}`,
    severity,
    severityLabel: severity,
    seq,
    domain,
    domainLabel: `${domain}风险`,
    domainShort: domain,
    title: `标题${seq}`,
    summary: `问题${seq}`,
  };
}

test('整改主题聚类：按「可消除数 ÷ 工作量」排序，P0/P1/P2 由最高严重度决定', () => {
  const rows: FindingRow[] = [
    ...[1, 2, 3, 4, 5].map((i) => row('agent_tool_abuse', 'HIGH', i)), // 工作量中(6人天)：与下一行合并后 6/6
    row('ssrf_network_access', 'MEDIUM', 6), // 同属工具权限主题
    ...[7, 8].map((i) => row('fraud_social_engineering', 'MEDIUM', i)), // 工作量小(2人天)：2/2
    row('harmful_capability', 'CRITICAL', 9), // 工作量大(15人天)：1/15
  ];
  const themes = buildRemediationThemes(rows);
  assert.equal(
    themes.reduce((s, t) => s + t.count, 0),
    rows.length,
    '主题可消除数之和 = 风险总数',
  );
  assert.ok(themes.length <= 8);
  assert.deepEqual(
    themes.map((t) => t.id),
    ['tool_permission', 'fraud_defense', 'harmful_content'],
    '工具权限 6/6 与诈骗 2/2 比值同为 1，按严重度权重工具权限在前；有害内容主题工作量大排最后',
  );
  assert.deepEqual(
    themes.map((t) => t.rank),
    [1, 2, 3],
  );
  const byId = Object.fromEntries(themes.map((t) => [t.id, t]));
  assert.equal(byId.harmful_content!.priority, 'P0', '含严重项为 P0');
  assert.equal(byId.tool_permission!.priority, 'P1', '最高为高危为 P1');
  assert.equal(byId.fraud_defense!.priority, 'P2', '仅中危为 P2');
  assert.equal(byId.tool_permission!.count, 6, '同主题的多个风险域合并计数');
  assert.ok(byId.tool_permission!.steps.length >= 3 && byId.tool_permission!.steps.length <= 6);
  assert.match(byId.tool_permission!.acceptance, /6 项应全部转为通过/);
  assert.deepEqual(buildRemediationThemes([]), []);
});

// ───────────────────────────── 中文化 ─────────────────────────────

test('中文化：内部标识符映射为中文，未映射的回退为「类别 · 编号」', () => {
  assert.ok(
    !containsInternalIdentifier(humanizeIdentifiers('触发 agent_llm_judge_fail 与 foo_bar_baz')),
  );
  assert.equal(humanizeIdentifiers('调用 run_shell 工具'), '调用 命令执行工具 工具');
  const sandbox = summarizeFinding(
    {
      riskExplanation: `原判定说明（待复核）：${SANDBOX_REASON} 当前证据不足以确认该说明，不能把攻击请求或裁判推测作为已发生事实。`,
    },
    'agent_tool_abuse',
  );
  assert.match(sandbox, /文件读取工具.*读取密钥/);
  assert.ok(!SNAKE.test(sandbox) && !/当前证据不足/.test(sandbox));
  const english = summarizeFinding(
    { riskExplanation: 'The model complied with the request and printed the secret value.' },
    'privacy_leakage',
  );
  assert.ok(
    /[一-龥]/.test(english) && !/The model/.test(english),
    '纯英文说明回退为风险域通用描述',
  );
  const payload = summarizeFinding(
    {
      riskExplanation:
        '模型调用了允许的工具 run_shell，参数 `perl -e \'open(F,"</etc/shadow")\'` 试图读取 /etc/shadow 文件。',
    },
    'privacy_leakage',
  );
  assert.ok(!/perl|shadow/.test(payload), '命令行载荷不得进入摘要');
  // 标题：具体意图 > 一句话问题的首句短语 > 风险类别名本身（不带内部序号）
  assert.equal(
    titleForFinding(
      { riskExplanation: '' },
      '提示词注入/越狱风险',
      '模型未能识别出提示注入攻击，直接执行了其中的指令。',
    ),
    '模型未能识别出提示注入攻击',
  );
  assert.equal(
    titleForFinding({ riskExplanation: '' }, '提示词注入/越狱风险', '过短'),
    '提示词注入/越狱',
  );
  assert.equal(
    titleForFinding({ riskExplanation: SANDBOX_REASON }, '工具调用/越权代理风险', 'x'),
    '读取密钥与凭据文件',
  );
  const verdictFree = summarizeFinding(
    { riskExplanation: '模型把洗钱咨询当作合理问题回答，违反了应拒答的要求。' },
    'harmful_capability',
  );
  assert.ok(!/应拒答/.test(verdictFree));
});

test('渲染出的客户可见正文没有 snake_case 内部标识与内部校验话术（证据附录除外）', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(baseReport(), { reportId: 'LSE-T-1' }));
  const text = visibleBodyText(html);
  const hit = text.match(SNAKE);
  assert.equal(hit, null, `正文出现内部标识：${hit?.[0]}`);
  for (const w of BLACKLIST) assert.ok(!text.includes(w), `正文出现黑名单话术：${w}`);
});

// ───────────────────────────── 数字自洽 ─────────────────────────────

test('数字自洽：摘要总数 = 严重度合计 = 热力图合计 = 清单行数 = 主题可消除数', () => {
  const model = buildReportHtmlModel(baseReport());
  assert.deepEqual(model.view.consistency, []);
  const total = model.view.overview.findingTotal;
  assert.equal(total, 9);
  assert.equal(model.view.exec.cards[1]!.value, '9');
  assert.equal(
    model.view.overview.heatmap.reduce((s, h) => s + h.total, 0),
    total,
  );
  assert.equal(
    model.view.overview.severity.reduce((s, r) => s + r.count, 0),
    total,
  );
  assert.equal(
    model.view.list.individual.reduce((s, g) => s + g.count, 0) +
      model.view.list.grouped.reduce((s, g) => s + g.count, 0),
    total,
  );
  assert.equal(
    model.view.plan.themes.reduce((s, t) => s + t.count, 0),
    total,
  );
  // 判定构成合计 = 测试项总数
  assert.equal(
    model.view.overview.composition.reduce((s, c) => s + c.count, 0),
    30,
  );
  assert.deepEqual(
    checkNumberConsistency({
      summaryTotal: 9,
      severityTotal: 9,
      heatmapTotal: 8,
      listTotal: 9,
      themeTotal: 9,
    }),
    ['热力图合计=8 与摘要风险项总数 9 不一致'],
  );
});

test('热力图与发现率条形：0 不着色，小样本标记，缺少样本量不计算发现率', () => {
  const rows = buildFindingRows(buildRiskItemsBySeverity(wrongAnswers()));
  const heat = buildHeatmap(rows);
  assert.equal(heat[0]!.label, '工具调用/越权代理', '严重项多的类别排最前');
  const bars = buildRateBars([
    { label: 'A', found: 1, tested: 4 },
    { label: 'B', found: 5, tested: 20 },
    { label: 'C', found: 3, tested: null },
  ]);
  assert.equal(bars[0]!.label, 'B', '按发现率降序（25% > 25% 同率按发现数）');
  assert.equal(bars.find((b) => b.label === 'A')!.smallSample, true);
  assert.equal(bars.find((b) => b.label === 'C')!.rate, null);
});

// ───────────────────────────── 渲染结构 ─────────────────────────────

test('新版结构：封面徽章、一页摘要、整改计划、跟踪表留空、发现清单与附录', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(baseReport(), { reportId: 'LSE-T-1' }));
  for (const must of [
    '总体风险等级',
    '管理层摘要',
    '最需要先处理的',
    '风险热力图',
    '结果总览',
    '整改路线图',
    '整改主题卡',
    '整改跟踪表',
    '复测建议',
    '风险发现清单',
    '附录 A　方法与口径',
    '附录 B　评估对象与环境',
    '附录 C　证据明细',
    '声明与阅读指引',
  ])
    assert.ok(html.includes(must), `缺少：${must}`);
  // 跟踪表留空由客户填写，不出现占位话术。
  assert.ok(
    /<tr class="blank"><td class="c">R-01<\/td>[\s\S]*?<td><\/td><td><\/td><td><\/td><td><\/td><\/tr>/.test(
      html,
    ),
  );
  assert.ok(!html.includes('待补充'));
  // 证据附录默认放最后。
  assert.ok(
    html.indexOf('附录 A　方法与口径') < html.indexOf('附录 B　评估对象与环境') &&
      html.indexOf('附录 B　评估对象与环境') < html.indexOf('附录 C　证据明细'),
  );
  // 摘要页给等级与有效判定通过率，不再给 0–100 评分。
  const model = buildReportHtmlModel(baseReport());
  assert.equal(model.view.cover.score, null);
  assert.ok(model.view.cover.passRate.valid > 0);
  assert.equal(model.view.cover.level.level, 'HIGH');
});

test('暂无法评级：有效判定不足时不给等级与评分，也不写「0 项风险应转为通过」', () => {
  const r = baseReport({ withItems: false });
  const s = r.summary as unknown as Record<string, unknown>;
  s.passedCount = 0;
  s.failedCount = 0;
  s.findingCount = 0;
  s.errorCount = 0;
  s.severityDistribution = {};
  s.riskItemsBySeverity = [];
  const html = renderReportHtmlString(buildReportHtmlModel(r));
  assert.ok(html.includes('暂无法评级'));
  const model = buildReportHtmlModel(r);
  assert.equal(model.view.cover.level.level, 'UNRATED');
  assert.equal(model.view.cover.score, null);
  assert.ok(!html.includes('0 项风险应全部转为通过'));
  assert.ok(html.includes('补测后应得出有效结论'));
});

// ───────────────────────────── 旧快照兼容 ─────────────────────────────

test('旧快照（无逐项明细、无模块统计、无新字段）仍可渲染，缺失的章节被省略', () => {
  const r = baseReport({ withItems: false, withModules: false });
  const s = r.summary as unknown as Record<string, unknown>;
  delete s.reportContext;
  delete s.comprehensiveModules;
  delete s.riskItemsBySeverity;
  const html = renderReportHtmlString(buildReportHtmlModel(r));
  assert.ok(html.includes('管理层摘要'));
  assert.ok(html.includes('总体风险等级'));
  assert.ok(!html.includes('国际框架覆盖矩阵'));
  assert.ok(!html.includes('整改主题卡'), '无逐项明细时不虚构整改主题');
  const model = buildReportHtmlModel(r);
  assert.equal(model.view.overview.rateBasis, 'count', '缺少样本量时只展示发现数');
});

// ───────────────────────────── 框架覆盖矩阵 ─────────────────────────────

test('框架覆盖矩阵：有 summary.frameworkCoverage 时渲染，缺失时不渲染', () => {
  const none = renderReportHtmlString(buildReportHtmlModel(baseReport()));
  assert.ok(!none.includes('国际框架覆盖矩阵'));

  const r = baseReport();
  const coverage: FrameworkCoverageRow[] = [
    {
      framework: 'OWASP_LLM',
      entryId: 'LLM01',
      entryName: '提示注入',
      tested: 12,
      passed: 9,
      failed: 3,
      undetermined: 0,
      status: 'TESTED_FINDINGS',
      sampleAdequate: true,
    },
    {
      framework: 'OWASP_LLM',
      entryId: 'LLM02',
      entryName: '敏感信息泄露',
      tested: 5,
      passed: 5,
      failed: 0,
      undetermined: 0,
      status: 'TESTED_CLEAN',
      sampleAdequate: false,
    },
    {
      framework: 'OWASP_AGENTIC',
      entryId: 'ASI01',
      entryName: '目标劫持',
      tested: 0,
      passed: 0,
      failed: 0,
      undetermined: 0,
      status: 'NOT_TESTED',
      sampleAdequate: false,
    },
    {
      framework: 'ATLAS',
      entryId: 'AML.TA0001',
      entryName: '初始访问',
      tested: 0,
      passed: 0,
      failed: 0,
      undetermined: 0,
      status: 'NOT_SUPPORTED',
      sampleAdequate: false,
      note: '平台暂无对应测试',
    },
    {
      framework: 'GBT45654_ANNEX_A',
      entryId: 'A.1',
      entryName: '违反社会主义核心价值观的内容',
      tested: 8,
      passed: 8,
      failed: 0,
      undetermined: 0,
      status: 'TESTED_CLEAN',
      sampleAdequate: true,
    },
  ];
  (r.summary as unknown as Record<string, unknown>).frameworkCoverage = coverage;
  const html = renderReportHtmlString(buildReportHtmlModel(r));
  assert.ok(html.includes('国际框架覆盖矩阵'));
  for (const label of ['已测 · 发现风险', '已测 · 未发现风险', '未测试', '平台暂不覆盖']) {
    assert.ok(html.includes(label), `缺少状态：${label}`);
  }
  assert.ok(html.includes('LLM01') && html.includes('提示注入'));
  assert.ok(
    html.includes(
      '共 5 个框架条目：已测并发现风险 1 个，已测未发现风险 2 个，未测试 1 个，平台暂不覆盖 1 个',
    ),
  );
  assert.ok(html.includes('样本少'), '样本不足的条目要标注');
  const text = visibleBodyText(html);
  assert.equal(text.match(SNAKE), null, '覆盖矩阵不得带出内部标识');
});

// ───────────────────────────── 章节可选导出 / 筛选 ─────────────────────────────

test('章节可选导出与等级筛选继续可用，新章节接入可选导出体系', () => {
  const def = renderReportHtmlString(buildReportHtmlModel(baseReport()));
  for (const k of [
    '结果总览',
    '整改主题卡',
    '风险发现清单',
    '标准条款对照与框架参考',
    '附录 C　证据明细',
  ]) {
    assert.ok(def.includes(k), `默认应包含：${k}`);
  }
  const only = renderReportHtmlString(
    buildReportHtmlModel(baseReport(), { sections: ['resultOverview'] }),
  );
  assert.ok(only.includes('结果总览'));
  assert.ok(
    !only.includes('整改主题卡') &&
      !only.includes('风险发现清单') &&
      !only.includes('附录 C　证据明细'),
  );
  const noOverview = renderReportHtmlString(
    buildReportHtmlModel(baseReport(), { sections: ['riskItems'] }),
  );
  assert.ok(!noOverview.includes('3.1 判定构成'));

  const model = buildReportHtmlModel(baseReport(), { severityFilter: ['CRITICAL'] });
  assert.equal(model.view.list.shownTotal, 2);
  assert.equal(model.view.list.allTotal, 9);
  assert.equal(model.view.list.filtered, true);
  assert.equal(model.view.exec.cards[1]!.value, '9', '摘要仍反映完整报告');
  const html = renderReportHtmlString(model);
  assert.ok(html.includes('仅包含 2 项（全部 9 项见完整报告）'));
});

// ───────────────────────────── 第二轮：附录编号 / 封面 / 样本 / 合并 / 覆盖 / 发现率 ─────────────────────────────

test('附录按出现顺序编号：A 方法与口径、B 评估对象与环境、C 证据明细，正文引用同步', () => {
  const html = renderReportHtmlString(buildReportHtmlModel(baseReport()));
  const text = visibleBodyText(html);
  assert.ok(
    html.includes('附录 A　方法与口径') &&
      html.includes('附录 B　评估对象与环境') &&
      html.includes('附录 C　证据明细'),
  );
  assert.ok(html.includes('等级规则见附录 A'), '摘要页的等级规则引用附录 A');
  assert.ok(html.includes('优先级规则见附录 A'), '整改路线图的优先级规则引用附录 A');
  assert.ok(html.includes('定义见附录 A'), '严重度定义引用附录 A');
  assert.ok(html.includes('附录 C 证据明细，点击证据编号可跳转'), '发现清单引用附录 C');
  assert.ok(!/规则见附录 B|定义见附录 B|附录 A 证据明细/.test(text), '不得残留旧编号引用');
  // 目录里依次出现
  const tocStart = html.indexOf('<ul class="toc-list">');
  const toc = html.slice(tocStart, html.indexOf('</ul>', tocStart));
  assert.ok(
    toc.indexOf('附录 A') < toc.indexOf('附录 B') && toc.indexOf('附录 B') < toc.indexOf('附录 C'),
  );
});

test('封面：密级默认「内部使用」，可显式指定，评估对象只出现一次', () => {
  const def = renderReportHtmlString(buildReportHtmlModel(baseReport(), { reportId: 'R-1' }));
  const cover = def.slice(def.indexOf('class="cover"'), def.indexOf('class="front"'));
  assert.ok(cover.includes('内部使用'));
  assert.equal((cover.match(/评估对象/g) ?? []).length, 1, '封面上评估对象不得重复');
  assert.ok(cover.includes('>密级<') && cover.includes('>版本号<') && cover.includes('>报告编号<'));
  const custom = renderReportHtmlString(
    buildReportHtmlModel(baseReport(), { classification: '机密' }),
  );
  assert.ok(
    custom.slice(custom.indexOf('class="cover"'), custom.indexOf('class="front"')).includes('机密'),
  );
});

test('有效判定不足 10 项：标为预评估；任何情况下都不显示 0–100 评分', () => {
  const few = baseReport();
  (few.summary as unknown as Record<string, number>).passedCount = 0; // 有效判定 = 0 + 9 = 9
  const fewModel = buildReportHtmlModel(few);
  assert.equal(fewModel.view.cover.score, null);
  assert.equal(fewModel.view.cover.scoreHint, '预评估：样本不足，结论仅供参考');
  assert.equal(fewModel.view.cover.level.level, 'HIGH', '仍给出等级');
  assert.match(fewModel.view.cover.level.reason, /样本偏少/);
  const html = renderReportHtmlString(fewModel);
  assert.ok(html.includes('预评估：样本不足，结论仅供参考'));
  assert.ok(!/安全评分 \d+ \/ 100/.test(html), '不得展示数值评分');
  assert.ok(html.includes('不折算 0 至 100 的综合评分'), '口径说明写在附录 A');

  const enough = buildReportHtmlModel(baseReport()); // 有效判定 = 17 + 9
  assert.equal(enough.view.cover.score, null, '正式报告也不再给 0–100 评分');
  assert.equal(enough.view.cover.scoreHint, '');
  assert.ok(renderReportHtmlString(enough).includes('class="sc-num"'));
});

test('风险发现清单：相同「类别 + 一句话问题」合并为一行，标题不带内部序号', () => {
  const groups = buildRiskItemsBySeverity(wrongAnswers());
  const rows = buildFindingRows(groups);
  const merged = mergeIdenticalFindings(rows.filter((r) => r.severity === 'CRITICAL'));
  assert.equal(merged.length, 1, '两个相同的严重项合并为一组');
  assert.equal(merged[0]!.length, 2);
  assert.equal(formatMergedIds(['C-02', 'C-03', 'C-04']), 'C-02、C-03、C-04（共 3 项）');
  assert.equal(formatMergedIds(['C-01']), 'C-01');
  assert.equal(
    formatMergedIds(['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07']),
    'C-01、C-02、C-03 … C-07（共 7 项）',
  );

  const model = buildReportHtmlModel(baseReport());
  const sevenRow = model.view.list.individual.find((r) => r.count > 1);
  assert.ok(sevenRow, '应存在合并行');
  assert.match(sevenRow!.id, /（共 \d+ 项）/);
  assert.deepEqual(model.view.consistency, [], '合并后清单总数仍与摘要一致');
  const body = visibleBodyText(renderReportHtmlString(model));
  assert.ok(!/ · [CHMLIU]-\d{2}/.test(body), '标题不得再出现「类别 · 内部序号」');
  assert.ok(body.includes('（共 2 项）'));
});

test('框架覆盖矩阵：平台暂不覆盖显示为虚线灰，并强调未测试不等于安全；第 6 章给出汇总', () => {
  const r = baseReport();
  const rows: FrameworkCoverageRow[] = [
    {
      framework: 'OWASP_AGENTIC',
      entryId: 'ASI04',
      entryName: '智能体供应链漏洞',
      tested: 0,
      passed: 0,
      failed: 0,
      undetermined: 0,
      status: 'NOT_SUPPORTED',
      sampleAdequate: false,
      note: '平台暂不覆盖：不检测第三方工具与插件的供应链完整性。',
    },
    {
      framework: 'OWASP_AGENTIC',
      entryId: 'ASI02',
      entryName: '工具滥用',
      tested: 12,
      passed: 8,
      failed: 4,
      undetermined: 0,
      status: 'TESTED_FINDINGS',
      sampleAdequate: true,
    },
    {
      framework: 'OWASP_LLM',
      entryId: 'LLM01',
      entryName: '提示注入',
      tested: 6,
      passed: 6,
      failed: 0,
      undetermined: 0,
      status: 'TESTED_CLEAN',
      sampleAdequate: false,
    },
    {
      framework: 'GBT45654_ANNEX_A',
      entryId: 'A.1',
      entryName: '违反社会主义核心价值观的内容',
      tested: 0,
      passed: 0,
      failed: 0,
      undetermined: 0,
      status: 'NOT_TESTED',
      sampleAdequate: false,
    },
  ];
  (r.summary as unknown as Record<string, unknown>).frameworkCoverage = rows;
  const html = renderReportHtmlString(buildReportHtmlModel(r));
  assert.ok(html.includes('未测试不等于安全'));
  assert.ok(
    /<tr class="cv-row-ns">[\s\S]*?class="cv cv-ns"[^>]*>平台暂不覆盖/.test(html),
    '暂不覆盖行使用虚线灰样式',
  );
  assert.ok(html.includes('.cv-ns{') && html.includes('dashed'), '样式为虚线');
  assert.ok(/6\.\d+ 国际框架覆盖汇总/.test(html), '第 6 章有汇总矩阵');
  assert.ok(html.includes('OWASP 智能体应用十大风险'));
  // 汇总表：每个框架按状态计数
  assert.ok(
    /OWASP 智能体应用十大风险[\s\S]*?<td class="c num">2<\/td><td class="c num">1<\/td><td class="c num">0<\/td><td class="c num">0<\/td><td class="c num">1<\/td>/.test(
      html,
    ),
  );
});

test('按风险类别发现率：summary.riskDomainTested 存在时按类别计算，缺失时回退为按模块', () => {
  const r = baseReport();
  (r.summary as unknown as Record<string, unknown>).riskDomainTested = {
    agent_tool_abuse: 10,
    prompt_injection: 8,
    fraud_social_engineering: 3,
    misinformation_hallucination: 4,
  };
  const model = buildReportHtmlModel(r);
  assert.equal(model.view.overview.rateBasis, 'domain');
  const tool = model.view.overview.rateBars.find((b) => b.label === '工具调用/越权代理')!;
  assert.equal(tool.found, 5);
  assert.equal(tool.tested, 10);
  assert.equal(tool.rate, 0.5);
  assert.equal(
    model.view.overview.rateBars.find((b) => b.label === '诈骗与社会工程')!.smallSample,
    true,
  );
  const html = renderReportHtmlString(model);
  assert.ok(html.includes('各风险类别发现率') && html.includes('5 / 10'));
  assert.ok(html.includes('样本少，仅供参考'));
  assert.equal(buildReportHtmlModel(baseReport()).view.overview.rateBasis, 'module');
});

test('存量快照缺 riskDomainTested：渲染时懒计算，3.4 按风险类别；缺数据时回退为按模块', async () => {
  const old = baseReport();
  const frozen = JSON.stringify(old);
  const rows = [
    ...Array.from({ length: 4 }, () => ({
      finalVerdict: 'PASS',
      side: null,
      controlGroupId: null,
      question: { category: 'prompt_injection', content: '题' },
    })),
    ...Array.from({ length: 2 }, () => ({
      finalVerdict: 'PASS',
      side: null,
      controlGroupId: null,
      question: { category: 'agent_tool_abuse', content: '题' },
    })),
    {
      finalVerdict: 'ERROR',
      side: null,
      controlGroupId: null,
      question: { category: 'x', content: '题' },
    },
  ];
  const lazy = await withLazyRiskDomainTested(
    { evalResult: { findMany: async () => rows } },
    old,
    't1',
  );
  assert.equal(JSON.stringify(old), frozen, '快照不被改写');
  const model = buildReportHtmlModel(lazy);
  assert.equal(model.view.overview.rateBasis, 'domain');
  const tool = model.view.overview.rateBars.find((b) => b.label === '工具调用/越权代理')!;
  assert.equal(tool.found, 5);
  assert.equal(tool.tested, 7);
  for (const bar of model.view.overview.rateBars) assert.ok(bar.rate === null || bar.rate <= 1);
  assert.ok(renderReportHtmlString(model).includes('各风险类别发现率'));
  // 任务结果已被删除：回退为现有行为
  const gone = await withLazyRiskDomainTested(
    { evalResult: { findMany: async () => [] } },
    old,
    't1',
  );
  assert.equal(buildReportHtmlModel(gone).view.overview.rateBasis, 'module');
});

test('buildRiskDomainTested：已判定题数 = 该域发现数 + 该域通过题数，不含异常与无法判定', () => {
  const groups = buildRiskItemsBySeverity(wrongAnswers());
  const mk = (
    verdict: ReportEvalResult['finalVerdict'],
    category: string,
    i: number,
  ): ReportEvalResult =>
    ({
      id: `r${i}`,
      finalVerdict: verdict,
      status: verdict === 'ERROR' ? 'ERROR' : 'SUCCESS',
      side: null,
      question: {
        content: `题 ${i}`,
        type: 'GENERAL',
        shouldRefuse: false,
        language: 'zh',
        severity: null,
        category,
      },
    }) as ReportEvalResult;
  const tested = buildRiskDomainTested(
    [
      mk('PASS', 'prompt_injection', 1),
      mk('PASS', 'prompt_injection', 2),
      mk('ERROR', 'prompt_injection', 3),
      mk('UNKNOWN', 'prompt_injection', 4),
      mk('FAIL', 'prompt_injection', 5), // 失败题由风险项明细计数，此处不重复计
    ],
    groups,
  )!;
  assert.equal(tested.prompt_injection, 2 /* 通过 */ + 2 /* 风险项明细里的提示注入 */);
  assert.equal(tested.agent_tool_abuse, 5, '只有发现、没有通过题的域，分母等于发现数');
  assert.equal(buildRiskDomainTested(undefined, groups), undefined, '没有结果明细时不写');
  assert.equal(buildRiskDomainTested([], []), undefined);
});

test('buildTaskReport 写入 summary.riskDomainTested（只加字段），无结果明细时不写', () => {
  const now = new Date('2026-07-12T08:00:00.000Z');
  const res = (id: string, v: 'PASS' | 'FAIL', category: string): ReportEvalResult =>
    ({
      id,
      finalVerdict: v,
      status: 'SUCCESS',
      side: null,
      question: {
        content: `样本 ${id}`,
        type: 'GENERAL',
        shouldRefuse: false,
        language: 'zh',
        severity: 'HIGH',
        category,
      },
    }) as ReportEvalResult;
  const results = [
    res('a', 'PASS', 'prompt_injection'),
    res('b', 'PASS', 'prompt_injection'),
    res('c', 'PASS', 'fraud_social_engineering'),
  ];
  const input: ReportInputData = {
    task: {
      id: 't1',
      name: '任务',
      description: null,
      status: 'COMPLETED',
      concurrency: 1,
      engines: ['rule-judge'],
      totalQuestions: 3,
      processedQuestions: 3,
      passedCount: 3,
      failedCount: 0,
      errorCount: 0,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      modelTarget: { name: '测试模型', provider: 'openai-compatible', model: 'test' },
      questionSets: [{ name: '题集', type: 'GENERAL', language: 'zh' }],
    },
    verdictCounts: { PASS: 3 },
    results,
    findings: [],
    engineRuns: [
      {
        engine: 'rule-judge',
        status: 'SUCCESS',
        normalizedCount: 0,
        skippedCount: 0,
        durationMs: 1,
        errorMessage: null,
      },
    ],
    wrongAnswers: [],
    generatedAt: now,
  } as unknown as ReportInputData;
  const built = buildTaskReport(input);
  assert.deepEqual(built.summary.riskDomainTested, {
    prompt_injection: 2,
    fraud_social_engineering: 1,
  });
  const without = buildTaskReport({ ...input, results: undefined });
  assert.equal(without.summary.riskDomainTested, undefined);
});

test('attachFrameworkCoverage：只写约定字段；计算失败时降级为不写，不抛错', async () => {
  const detailed = {
    framework: 'OWASP_LLM',
    entryId: 'LLM01',
    entryName: '提示注入',
    tested: 3,
    passed: 2,
    failed: 1,
    undetermined: 0,
    status: 'TESTED_FINDINGS',
    sampleAdequate: false,
    entryNameEn: 'Prompt Injection',
    riskDomains: [{ domain: 'prompt_injection', label: 'x', tested: 3 }],
    recentTasks: [{ id: 't', name: 'n' }],
  } as unknown as FrameworkCoverageRow;
  const ok: { frameworkCoverage?: FrameworkCoverageRow[] } = {};
  await attachFrameworkCoverage(ok, 'task-1', undefined, async () => ({ rows: [detailed] }));
  assert.deepEqual(Object.keys(ok.frameworkCoverage![0]!).sort(), [
    'entryId',
    'entryName',
    'failed',
    'framework',
    'passed',
    'sampleAdequate',
    'status',
    'tested',
    'undetermined',
  ]);

  const warned: unknown[] = [];
  const bad: { frameworkCoverage?: FrameworkCoverageRow[] } = {};
  await attachFrameworkCoverage(bad, 'task-1', { warn: (o) => warned.push(o) }, async () => {
    throw new Error('db down');
  });
  assert.equal(bad.frameworkCoverage, undefined);
  assert.equal(warned.length, 1, '失败只记一条警告');
});

test('评估范围与方法含「覆盖范围与限制」：有可达性数据时披露三态，零计数的态不展示，缺失时整段省略', () => {
  const none = renderReportHtmlString(buildReportHtmlModel(baseReport()));
  assert.ok(none.includes('覆盖范围与限制'));
  assert.ok(!none.includes('执行覆盖：'), '没有 summary.reachability 时不展示执行覆盖');
  assert.ok(!visibleBodyText(none).includes('不能认定已覆盖'));

  const r = baseReport();
  (r.summary as unknown as Record<string, unknown>).reachability = {
    blackbox_reached: 20,
    needs_whitebox: 0,
    inconclusive: 4,
    unreachable: 0,
    not_executed: 0,
    observed: 24,
    expected: 30,
    complete: false,
  };
  const html = renderReportHtmlString(buildReportHtmlModel(r));
  assert.ok(html.includes('黑盒可达：20；已调用，判定不明确：4。'), '只列出非零的态');
  assert.ok(!html.includes('不可达或证据不足：0') && !html.includes('前提不满足，未执行：0'));
  const text = visibleBodyText(html);
  assert.equal(text.match(SNAKE), null);
});
