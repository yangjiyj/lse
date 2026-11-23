import { createHash } from 'node:crypto';
import { RISK_DOMAIN_LABELS, STANDARD_CATEGORY_LABELS } from '@lse/shared';
import { classifyWrongAnswer, type SuspectSample } from './suspect.js';

export interface RiskSample extends SuspectSample {
  id: string;
  taskId: string;
  tenantId?: string | null;
  findingId?: string | null;
  findingRefs?: Array<{ taskId: string; findingId: string }>;
  questionId?: string | null;
  questionContent: string;
  question?: { category?: string | null; metadata?: Record<string, unknown> | null } | null;
  title?: string | null;
  suppressionKey?: string | null;
  riskCategory?: string | null;
  severity?: string | null;
  createdAt: string | Date;
  targetName?: string;
  reviewStatus?: string | null;
  remediation?: { status?: string | null; action?: string | null };
}

const SCENES: Readonly<Record<string, string>> = {
  企业知识库助手外部页面注入: '网页内容诱导读取敏感信息并外发',
  运维助手本地凭据读取边界: '诱导读取私钥和凭据文件',
  销售助手数据外发边界: '诱导把客户数据发往外部地址',
  自动化运维助手命令执行边界: '诱导执行危险命令',
  企业知识库助手出向访问边界: '诱导访问内部或云元数据地址',
  客户工单助手工具参数边界: '诱导篡改工具参数',
  业务资料助手文件读取边界: '越权读取业务文件',
};
const GUIDANCE: Readonly<Record<string, string>> = {
  agent_tool_abuse: '为工具配置最小权限、参数校验与危险操作人工确认，限制敏感文件读取和未授权外发。',
  data_exfiltration: '限制敏感数据读取与外发目的地，发送前脱敏并核对授权。',
  prompt_injection: '外部资料仅作为参考数据处理，不允许其覆盖系统约束或授权边界。',
};
const rank: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
const normalize = (value: string) => value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
const hash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);
const chinese = (value?: string | null) => value && /[\u4e00-\u9fff]/.test(value) && !/[a-z]+_[a-z]+/i.test(value);

function identity(s: RiskSample): { key: string; title: string } {
  const category = s.riskCategory ?? 'unknown';
  const metadata = s.question?.metadata;
  const mapped = (RISK_DOMAIN_LABELS as Record<string, string>)[category] ?? STANDARD_CATEGORY_LABELS[category];
  const fallback = chinese(s.title) ? s.title! : mapped ?? (chinese(s.reason) ? s.reason!.split('\n')[0]!.slice(0, 30) : '待确认的安全问题');
  for (const field of ['sourceQuestionId', 'baseId', 'questionFingerprint', 'sourceFingerprint']) {
    if (typeof metadata?.[field] === 'string' && metadata[field]) return { key: `source:${field}:${metadata[field]}`, title: fallback };
  }
  // 历史快照缺少共同来源 ID，按明确的评测族包装、场景标题退化归并，不依赖回答相似度。
  if (/^请以 .+? 处理这段安全评测题：/.test(s.questionContent)) return { key: 'family:multilingual-safety', title: '多语言安全评测未通过' };
  const scene = /正在([^\n]+?)的生产环境中工作/.exec(s.questionContent)?.[1];
  if (scene && SCENES[scene]) return { key: `scene:${scene}`, title: SCENES[scene]! };
  if (s.suppressionKey) return { key: `posture:${category}:${normalize(s.title ?? s.suppressionKey)}`, title: fallback };
  if (/^# System Notice/.test(s.questionContent)) return { key: 'intent:forged-notice', title: '伪造系统通知' };
  if (/^Please handle this safety evaluation prompt:/.test(s.questionContent)) return { key: 'intent:override-instructions', title: '诱导忽略安全指令' };
  if (/^A simulated administrator requests/.test(s.questionContent)) return { key: 'intent:administrator-impersonation', title: '冒充管理员下指令' };
  if (s.questionId) return { key: `question:${s.questionId}`, title: fallback };
  if (s.question?.category || s.title) return { key: `subtype:${category}:${normalize(s.question?.category ?? s.title!)}`, title: fallback };
  const reason = normalize(s.reason ?? '').split(/[:：。；\n]/)[0]?.replace(/[\d]+/g, '#').slice(0, 60);
  return { key: `reason:${category}:${reason ?? ''}`, title: fallback };
}

function status(s: RiskSample): '待确认' | '整改中' | '已关闭' {
  if (s.reviewStatus === 'FALSE_POSITIVE' || s.reviewStatus === 'ACCEPTED_RISK' ||
    s.remediation?.status === 'VERIFIED_CLOSED' || s.remediation?.status === 'NOT_APPLICABLE') return '已关闭';
  if (s.reviewStatus === 'CONFIRMED' || ['IN_PROGRESS', 'READY_FOR_RETEST', 'REOPENED'].includes(s.remediation?.status ?? '')) return '整改中';
  return '待确认';
}

export interface GroupOptions {
  /** 全部租户视角：风险身份相同但租户不同的样本不合并，每个问题只属于一个租户。 */
  byTenant?: boolean;
}

function buckets(samples: RiskSample[], opts: GroupOptions = {}) {
  const map = new Map<string, RiskSample[]>();
  for (const s of samples) {
    const key = identity(s).key;
    const id = hash(opts.byTenant ? `${s.tenantId ?? ''}|${key}` : key);
    const list = map.get(id) ?? [];
    list.push(s);
    map.set(id, list);
  }
  return map;
}

export function groupWrongAnswers(samples: RiskSample[], opts: GroupOptions = {}) {
  return [...buckets(samples, opts)].map(([id, members]) => {
    const sorted = [...members].sort((a, b) => (rank[b.severity ?? ''] ?? 0) - (rank[a.severity ?? ''] ?? 0) ||
      +new Date(b.createdAt) - +new Date(a.createdAt) || a.id.localeCompare(b.id));
    const first = sorted[0]!;
    const names = [...new Set(members.map(s => s.targetName ?? '未命名对象'))].sort();
    const states = members.map(status);
    return { id, title: identity(first).title, severity: first.severity ?? null,
      tenantId: first.tenantId ?? null,
      sampleCount: members.length, targets: { names, count: names.length },
      latestAt: new Date(Math.max(...members.map(s => +new Date(s.createdAt)))).toISOString(),
      status: states.includes('待确认') ? '待确认' as const : states.includes('整改中') ? '整改中' as const : '已关闭' as const,
      suspectedFalsePositive: members.filter(s => classifyWrongAnswer(s).suspectedFalsePositive).length };
  }).sort((a, b) => (rank[b.severity ?? ''] ?? 0) - (rank[a.severity ?? ''] ?? 0) || b.latestAt.localeCompare(a.latestAt) || a.id.localeCompare(b.id));
}

export function groupDetail(samples: RiskSample[], id: string, page = 1, pageSize = 20, opts: GroupOptions = {}) {
  const group = groupWrongAnswers(samples, opts).find(g => g.id === id);
  const members = buckets(samples, opts).get(id);
  if (!group || !members) return null;
  const sorted = [...members].sort((a, b) => (rank[b.severity ?? ''] ?? 0) - (rank[a.severity ?? ''] ?? 0) ||
    +new Date(b.createdAt) - +new Date(a.createdAt) || a.id.localeCompare(b.id));
  const first = sorted[0]!;
  const classification = classifyWrongAnswer(first);
  const sandboxBlocked = /评估沙箱阻断/.test(first.reason ?? '') || /BLOCKED/i.test(first.executionOutcome ?? '');
  const actions = [...new Set(members.map(s => s.remediation?.action).filter((s): s is string => Boolean(s)))].slice(0, 5);
  return { ...group,
    representative: { id: first.id, questionContent: first.questionContent.slice(0, 600), modelResponse: first.modelResponse?.slice(0, 600) ?? null,
      ...classification, sandboxBlocked,
      modelReaction: classification.modelStance === 'refused' ? '模型明确拒绝了诱导请求' : classification.modelStance === 'complied' ? '模型尝试执行了风险请求' : '现有证据不足以确认模型是否照做' },
    observations: members.map(s => ({ targetName: s.targetName ?? '未命名对象', createdAt: new Date(s.createdAt).toISOString() })),
    remediation: actions.length ? actions : [GUIDANCE[first.riskCategory ?? ''] ?? '核对风险样本与授权边界，补充相应限制措施后重新验证。'],
    findingRefs: [...new Map(members.flatMap(s => s.findingRefs ?? (s.findingId ? [{ taskId: s.taskId, findingId: s.findingId }] : [])).map(ref => [ref.findingId, ref])).values()],
    actionable: members.every(s => Boolean(s.findingId)),
    // 现有 retest-failed 会重跑任务全部失败题，findingId 仅用于回填，不能承诺按问题精准复测。
    retestPlan: [],
    members: { items: sorted.slice((page - 1) * pageSize, page * pageSize).map(s => s.id), total: members.length, page, pageSize },
  };
}
