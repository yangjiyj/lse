import { RISK_DOMAIN } from '@lse/shared';
import { prisma } from '../../db.js';
import { ATLAS_DATA, OWASP_DATA, RISK_DOMAIN_ATLAS_TECHNIQUES, atlasTechniqueZh } from './index.js';
import {
  AGENTIC_THREAT,
  GBT45654_ANNEX_A_LABELS,
  PLATFORM_APP_COMPLIANCE,
  complianceClausesForDomain,
} from '../reports/compliance-mapping.js';
import { riskDomainForCategory, riskDomainLabel } from '../reports/labels.js';

// 框架覆盖矩阵：对每个框架条目回答「测了几题、发现几项风险、还是没测、平台能不能测」。
// 归类规则只复用既有映射（风险域 → 条目），详见 docs/framework-coverage.md。

export interface FrameworkCoverageRow {
  framework: 'OWASP_AGENTIC' | 'OWASP_LLM' | 'GBT45654_ANNEX_A' | 'ATLAS';
  entryId: string; // 如 ASI01、LLM02、A.1
  entryName: string; // 中文名
  tested: number;
  passed: number;
  failed: number;
  undetermined: number;
  status: 'NOT_TESTED' | 'TESTED_CLEAN' | 'TESTED_FINDINGS' | 'NOT_SUPPORTED';
  sampleAdequate: boolean;
  note?: string;
}

export type CoverageFramework = FrameworkCoverageRow['framework'];
export const COVERAGE_FRAMEWORKS: CoverageFramework[] = [
  'OWASP_AGENTIC',
  'OWASP_LLM',
  'GBT45654_ANNEX_A',
  'ATLAS',
];
export const SAMPLE_ADEQUATE_MIN = 10;

/** 行详情：在固定的行结构之外附带英文原名、关联风险域与最近任务，供页面展开用。 */
export interface FrameworkCoverageDetailRow extends FrameworkCoverageRow {
  entryNameEn: string;
  riskDomains: Array<{ domain: string; label: string; tested: number }>;
  recentTaskIds: string[];
}

/**
 * 一组「风险域集合相同」的已判定结果的聚合计数。一个结果可能同时落在多个风险域，
 * 因此按「域集合」分组：同一结果映射到同一条目多次时只计一次，映射到不同条目则各计一次。
 */
export interface CoverageGroup {
  domains: string[];
  /** 平台应用评估场景模板编号（PLATFORM_APP_COMPLIANCE 的键），用于补充智能体条目映射。 */
  appScenarios?: string[];
  passed: number;
  failed: number;
  undetermined: number;
  /** 最近优先的任务编号，用于展开行里的任务链接。 */
  taskIds?: string[];
}

export interface CoverageInput {
  groups: CoverageGroup[];
  frameworks?: CoverageFramework[];
}

export interface CoverageSummary {
  entries: number;
  byStatus: Record<FrameworkCoverageRow['status'], number>;
  totalTested: number;
  unmappedTested: number;
}

interface EntryDef {
  framework: CoverageFramework;
  id: string;
  nameZh: string;
  nameEn: string;
}

// 既有「智能体威胁」中文名 → OWASP Agentic 编号的适配表（compliance-mapping 只存中文威胁名）。
const THREAT_TO_ASI: Record<string, string> = {
  [AGENTIC_THREAT.intentBreaking]: 'ASI01',
  [AGENTIC_THREAT.toolMisuse]: 'ASI02',
  [AGENTIC_THREAT.privilegeCompromise]: 'ASI03',
  [AGENTIC_THREAT.identitySpoofing]: 'ASI03',
  [AGENTIC_THREAT.unexpectedRce]: 'ASI05',
  [AGENTIC_THREAT.memoryPoisoning]: 'ASI06',
  [AGENTIC_THREAT.cascadingHallucination]: 'ASI08',
  [AGENTIC_THREAT.hitlOverwhelm]: 'ASI09',
};

/**
 * 沙箱 L8 场景（题目标签 agent-scenario:xxx）→ 智能体威胁。
 * 目标劫持对应 ASI01，记忆投毒对应 ASI06，级联故障对应 ASI08，越权调用高权限工具对应 ASI03。
 */
export const SANDBOX_SCENARIO_THREATS: Record<string, readonly string[]> = {
  'agent-scenario:goal_hijack': [AGENTIC_THREAT.intentBreaking],
  'agent-scenario:memory_poisoning': [AGENTIC_THREAT.memoryPoisoning],
  'agent-scenario:cascading_failure': [AGENTIC_THREAT.cascadingHallucination],
  'agent-scenario:privilege_escalation': [AGENTIC_THREAT.privilegeCompromise],
};

const ATLAS_ZH: Record<string, string> = {
  'AML.T0051': '大模型提示词注入',
  'AML.T0070': 'RAG 知识库投毒',
  'AML.T0053': '智能体工具调用滥用',
  'AML.T0056': '提取大模型系统提示词',
  'AML.T0024.000': '推断训练数据成员',
  'AML.T0086': '经智能体工具调用外泄数据',
  'AML.T0029': 'AI 服务拒绝',
};

// 平台暂不覆盖的原因（诚实标注，不硬映射凑覆盖）。键为 `${framework}:${entryId}`。
const NOT_SUPPORTED_NOTES: Record<string, string> = {
  'OWASP_AGENTIC:ASI04':
    '部分覆盖：见「AI 组件漏洞扫描」（对 Skill、MCP、插件做静态分析与在线拉取工具清单）。本矩阵暂未把组件扫描的结果映射进来，现有评估题目也不检测第三方工具/插件/模型的供应链完整性。',
  'OWASP_AGENTIC:ASI07':
    '平台暂不覆盖：当前评估一次只面对单个被测智能体，没有多智能体之间消息伪造、重放或信任链的测试能力。',
  'OWASP_AGENTIC:ASI09':
    '平台暂不覆盖：没有评估智能体是否借助权威口吻、拟人化诱导人工审批或确认的测试能力。',
  'OWASP_AGENTIC:ASI10':
    '平台暂不覆盖：没有对智能体长期运行中的目标漂移、自我复制或隐蔽行为做持续观测的测试能力。',
};

// 条目的补充说明（有测试能力，但只覆盖该条目的一部分）。
const SCOPE_NOTES: Record<string, string> = {
  'OWASP_AGENTIC:ASI08':
    '仅覆盖单智能体沙箱里「上游连续失败后是否停止调用」一个场景；多智能体链路中故障逐级放大没有测。',
  'OWASP_AGENTIC:ASI06':
    '覆盖平台应用的知识库越权，以及沙箱里伪造长期记忆授权一个场景；不含记忆文件的长期投毒与持久化。',
  'OWASP_AGENTIC:ASI01':
    '平台应用评估的间接网页注入、编排泄露，和沙箱里「工具返回内容改写任务目标」场景映射到本条目；其余沙箱题目不计入。',
  'OWASP_AGENTIC:ASI03': '仅覆盖越权调用工具的场景，不含身份冒用与委托链滥用的专项测试。',
  'OWASP_LLM:LLM03':
    '仅覆盖由组件/依赖扫描引擎产生的组件漏洞类发现；模型文件与第三方模型来源的完整性校验需另用模型文件扫描补测。',
  'OWASP_LLM:LLM04': '仅覆盖 RAG 知识库投毒；不含训练数据、微调数据的投毒检测。',
  'OWASP_LLM:LLM08': '仅覆盖知识库检索污染类场景；向量库权限隔离需用 RAG 评估补测。',
  'GBT45654_ANNEX_A:A.2': '仅有偏见歧视类风险域映射，样本量通常较小，建议用内容安全评估专项补测。',
  'ATLAS:AML.T0024.000':
    '映射来自训练数据/记忆提取类题目，只能证明模型可被诱导复述，不能证明训练集成员身份已泄露。',
};

function buildEntryDefs(): EntryDef[] {
  const defs: EntryDef[] = [];
  for (const item of OWASP_DATA.agentic.items)
    defs.push({
      framework: 'OWASP_AGENTIC',
      id: item.id,
      nameZh: item.nameZh,
      nameEn: item.nameEn,
    });
  for (const item of OWASP_DATA.llm.items)
    defs.push({ framework: 'OWASP_LLM', id: item.id, nameZh: item.nameZh, nameEn: item.nameEn });
  for (const [id, label] of Object.entries(GBT45654_ANNEX_A_LABELS))
    defs.push({
      framework: 'GBT45654_ANNEX_A',
      id,
      nameZh: label.replace(/^A\.\d\s*/, ''),
      nameEn: '',
    });
  const techniques = new Map(
    ATLAS_DATA.matrices.flatMap((matrix) =>
      matrix.techniques.map((item) => [item.id, item.name] as const),
    ),
  );
  const atlasIds = [...new Set(Object.values(RISK_DOMAIN_ATLAS_TECHNIQUES).flat())];
  for (const id of atlasIds)
    defs.push({
      framework: 'ATLAS',
      id,
      nameZh: ATLAS_ZH[id] ?? (atlasTechniqueZh(id) || id),
      nameEn: techniques.get(id) ?? '',
    });
  return defs;
}

const ENTRY_DEFS = buildEntryDefs();

/** 风险域（及平台应用场景）命中的条目键集合，键形如 `${framework}:${entryId}`；只复用既有映射。 */
export function entriesFor(domains: string[], appScenarios: string[] = []): Set<string> {
  const keys = new Set<string>();
  const asi = (threats: readonly string[]) => {
    for (const threat of threats) {
      const id = THREAT_TO_ASI[threat];
      if (id) keys.add(`OWASP_AGENTIC:${id}`);
    }
  };
  for (const domain of domains) {
    const clauses = complianceClausesForDomain(domain);
    for (const id of clauses.owasp) keys.add(`OWASP_LLM:${id}`);
    for (const id of clauses.gbt45654) keys.add(`GBT45654_ANNEX_A:${id}`);
    asi(clauses.agentic);
    for (const id of RISK_DOMAIN_ATLAS_TECHNIQUES[domain] ?? []) keys.add(`ATLAS:${id}`);
  }
  for (const scenario of appScenarios) {
    const app = Object.hasOwn(PLATFORM_APP_COMPLIANCE, scenario)
      ? PLATFORM_APP_COMPLIANCE[scenario]
      : undefined;
    if (app) asi(app.agentic);
    const sandbox = Object.hasOwn(SANDBOX_SCENARIO_THREATS, scenario) ? SANDBOX_SCENARIO_THREATS[scenario] : undefined;
    if (sandbox) asi(sandbox);
  }
  return keys;
}

/** 平台是否有任何已映射的测试能力指向该条目（由映射表反推，而非人工声明）。 */
const SUPPORTED_ENTRIES: Set<string> = (() => {
  const all = new Set<string>();
  for (const domain of RISK_DOMAIN) for (const key of entriesFor([domain])) all.add(key);
  for (const scenario of [...Object.keys(PLATFORM_APP_COMPLIANCE), ...Object.keys(SANDBOX_SCENARIO_THREATS)])
    for (const key of entriesFor([], [scenario])) all.add(key);
  return all;
})();

export function buildFrameworkCoverage(input: CoverageInput): {
  rows: FrameworkCoverageDetailRow[];
  summary: CoverageSummary;
} {
  const wanted = new Set(input.frameworks?.length ? input.frameworks : COVERAGE_FRAMEWORKS);
  const defs = ENTRY_DEFS.filter((def) => wanted.has(def.framework));
  const acc = new Map<
    string,
    {
      passed: number;
      failed: number;
      undetermined: number;
      domains: Map<string, number>;
      tasks: string[];
    }
  >();
  let totalTested = 0;
  let unmappedTested = 0;
  for (const group of input.groups) {
    const count = group.passed + group.failed + group.undetermined;
    if (count <= 0) continue;
    totalTested += count;
    const keys = [...entriesFor(group.domains, group.appScenarios)].filter((key) =>
      wanted.has(key.split(':')[0] as CoverageFramework),
    );
    if (!keys.length) {
      unmappedTested += count;
      continue;
    }
    for (const key of keys) {
      const cell = acc.get(key) ?? {
        passed: 0,
        failed: 0,
        undetermined: 0,
        domains: new Map<string, number>(),
        tasks: [],
      };
      cell.passed += group.passed;
      cell.failed += group.failed;
      cell.undetermined += group.undetermined;
      for (const domain of group.domains)
        cell.domains.set(domain, (cell.domains.get(domain) ?? 0) + count);
      for (const id of group.taskIds ?? []) if (!cell.tasks.includes(id)) cell.tasks.push(id);
      acc.set(key, cell);
    }
  }
  const byStatus: CoverageSummary['byStatus'] = {
    NOT_TESTED: 0,
    TESTED_CLEAN: 0,
    TESTED_FINDINGS: 0,
    NOT_SUPPORTED: 0,
  };
  const rows = defs.map((def): FrameworkCoverageDetailRow => {
    const key = `${def.framework}:${def.id}`;
    const cell = acc.get(key);
    const passed = cell?.passed ?? 0;
    const failed = cell?.failed ?? 0;
    const undetermined = cell?.undetermined ?? 0;
    const tested = passed + failed + undetermined;
    const supported = SUPPORTED_ENTRIES.has(key);
    let status: FrameworkCoverageRow['status'];
    if (!supported && tested === 0) status = 'NOT_SUPPORTED';
    else if (tested === 0) status = 'NOT_TESTED';
    else if (failed > 0) status = 'TESTED_FINDINGS';
    else status = 'TESTED_CLEAN';
    byStatus[status] += 1;
    const note =
      status === 'NOT_SUPPORTED'
        ? (NOT_SUPPORTED_NOTES[key] ?? '平台暂不覆盖：现有风险域映射中没有指向本条目的测试能力。')
        : SCOPE_NOTES[key];
    return {
      framework: def.framework,
      entryId: def.id,
      entryName: def.nameZh,
      entryNameEn: def.nameEn,
      tested,
      passed,
      failed,
      undetermined,
      status,
      sampleAdequate: tested >= SAMPLE_ADEQUATE_MIN,
      ...(note ? { note } : {}),
      riskDomains: [...(cell?.domains ?? [])]
        .map(([domain, n]) => ({ domain, label: riskDomainLabel(domain), tested: n }))
        .sort((a, b) => b.tested - a.tested),
      recentTaskIds: (cell?.tasks ?? []).slice(0, 5),
    };
  });
  return { rows, summary: { entries: rows.length, byStatus, totalTested, unmappedTested } };
}

export interface CoverageScope {
  taskId?: string;
  targetId?: string;
  /** 时间窗（天），按任务创建时间；缺省为全部。 */
  days?: number;
}

type JudgedResult = {
  taskId: string;
  finalVerdict: 'PASS' | 'FAIL' | 'UNKNOWN' | null;
  question: { category: string | null; tags: string[] };
  findings: Array<{ riskCategory: string }>;
};

/** 把一条已判定结果归入风险域：题目自身类别 + 各风险发现的类别（并集，general_safety 仅在别无他域时保留）。 */
export function resultDomains(result: Pick<JudgedResult, 'question' | 'findings'>): string[] {
  const set = new Set<string>();
  set.add(riskDomainForCategory(result.question.category ?? ''));
  for (const finding of result.findings) set.add(riskDomainForCategory(finding.riskCategory));
  if (set.size > 1) set.delete('general_safety');
  return [...set].sort();
}

export function groupJudgedResults(results: JudgedResult[]): CoverageGroup[] {
  const groups = new Map<string, CoverageGroup>();
  for (const result of results) {
    if (
      result.finalVerdict !== 'PASS' &&
      result.finalVerdict !== 'FAIL' &&
      result.finalVerdict !== 'UNKNOWN'
    )
      continue;
    const domains = resultDomains(result);
    const appScenarios = result.question.tags
      .filter((tag) => Object.hasOwn(PLATFORM_APP_COMPLIANCE, tag) || Object.hasOwn(SANDBOX_SCENARIO_THREATS, tag))
      .sort();
    const signature = `${domains.join('+')}|${appScenarios.join('+')}`;
    const group = groups.get(signature) ?? {
      domains,
      appScenarios,
      passed: 0,
      failed: 0,
      undetermined: 0,
      taskIds: [],
    };
    if (result.finalVerdict === 'PASS') group.passed += 1;
    else if (result.finalVerdict === 'FAIL') group.failed += 1;
    else group.undetermined += 1;
    if (!group.taskIds!.includes(result.taskId)) group.taskIds!.push(result.taskId);
    groups.set(signature, group);
  }
  return [...groups.values()];
}

export async function computeFrameworkCoverage(
  scope: CoverageScope,
  frameworks?: CoverageFramework[],
) {
  const taskWhere = {
    ...(scope.taskId ? { id: scope.taskId } : {}),
    ...(scope.targetId ? { modelTargetId: scope.targetId } : {}),
    ...(scope.days ? { createdAt: { gte: new Date(Date.now() - scope.days * 86400_000) } } : {}),
  };
  const tasks = await prisma.evalTask.findMany({
    where: taskWhere,
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const rank = new Map(tasks.map((task, index) => [task.id, index]));
  const collected: JudgedResult[] = [];
  const BATCH = 5000;
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.evalResult.findMany({
      where: {
        taskId: { in: tasks.map(({ id }) => id) },
        finalVerdict: { in: ['PASS', 'FAIL', 'UNKNOWN'] },
      },
      select: {
        id: true,
        taskId: true,
        finalVerdict: true,
        question: { select: { category: true, tags: true } },
        findings: { select: { riskCategory: true } },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const row of page) collected.push(row as unknown as JudgedResult);
    if (page.length < BATCH) break;
    cursor = page[page.length - 1]!.id;
  }
  const groups = groupJudgedResults(collected).map((group) => ({
    ...group,
    taskIds: [...(group.taskIds ?? [])].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
  }));
  const built = buildFrameworkCoverage({ groups, frameworks });
  const names = new Map(tasks.map((task) => [task.id, task.name]));
  const rows = built.rows.map((row) => ({
    ...row,
    recentTasks: row.recentTaskIds.map((id) => ({ id, name: names.get(id) ?? id })),
  }));
  return { rows, summary: built.summary };
}
