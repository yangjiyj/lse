/**
 * 报告属于哪条测评线、标题与出具门槛的统一口径。
 */
import { classifyEvalTask } from '../task-category.js';
import type { EvalLine } from './types.js';

export interface ReportLineInput {
  engines: readonly string[];
  dimensions: readonly string[];
  /** 终端测评任务（配置体检、真机、运行态）。 */
  endpoint?: boolean;
}

/** 终端测评任务的引擎（配置体检、真机、运行态共用）。 */
const ENDPOINT_ENGINES = ['endpoint-agent-eval'];
/** 不对应标准条款的任务：组件漏洞扫描、RAG 专项（知识库投毒属攻击手法，不是附录 A 生成内容风险）。 */
const NON_STANDARD_DIMENSIONS = ['component_vulnerability', 'rag_quality', 'rag_security'];
const NON_STANDARD_ENGINES = ['ai-infra-guard', 'rag-eval'];

/**
 * 由任务的引擎与维度推断测评线。
 * 网关流量分析、持续闭环检测、组件漏洞扫描、RAG 专项不对应标准条款，返回空数组（报告不写标准依据）。
 */
export function reportLinesForTask(task: ReportLineInput): EvalLine[] {
  if (task.endpoint || task.engines.some((e) => ENDPOINT_ENGINES.includes(e))) return ['endpoint'];
  if (
    task.dimensions.some((d) => NON_STANDARD_DIMENSIONS.includes(d)) ||
    task.engines.some((e) => NON_STANDARD_ENGINES.includes(e))
  ) {
    return [];
  }
  switch (classifyEvalTask(task)) {
    case 'agent':
      return ['agent'];
    case 'comprehensive':
      return task.dimensions.includes('agent_tool_call') ? ['content', 'agent'] : ['content'];
    case 'content':
    case 'standard':
    case 'redteam':
    case 'regression':
      return ['content'];
    case 'gateway':
    case 'assurance':
      return [];
  }
}

/**
 * 标题里不得出现「符合性」「合规认证」「达标认证」等认证类字样：报告只说明所测范围内的表现。
 * 旧任务名里带这些字样的，出报告时替换为中性说法。
 */
const CERTIFICATION_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/符合性评估/g, '安全评估'],
  [/符合性检测/g, '安全检测'],
  [/符合性/g, ''],
  [/合规认证/g, '合规评估'],
  [/达标认证/g, '评估'],
];

export function neutralizeCertificationWording(text: string): string {
  let out = text;
  for (const [re, rep] of CERTIFICATION_WORDS) out = out.replace(re, rep);
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** 有效判定（通过 + 不合格）低于这个数时，报告标为「预评估（样本不足）」，不能作为正式结论。 */
export const FORMAL_REPORT_MIN_VALID = 10;

export type ReportGrade = 'formal' | 'preliminary' | 'blocked';

/**
 * 报告出具门槛：
 * - 有效判定为 0：不出具报告（blocked）；
 * - 少于 FORMAL_REPORT_MIN_VALID：预评估（preliminary），封面标注样本不足；
 * - 否则：正式报告（formal）。
 */
export function reportGradeForValidCount(valid: number): ReportGrade {
  if (valid <= 0) return 'blocked';
  if (valid < FORMAL_REPORT_MIN_VALID) return 'preliminary';
  return 'formal';
}

export const REPORT_GRADE_LABELS: Record<ReportGrade, string> = {
  formal: '正式报告',
  preliminary: '预评估（样本不足，结论仅供参考）',
  blocked: '有效判定为 0，不出具报告',
};
