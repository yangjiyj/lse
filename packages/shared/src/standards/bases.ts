/**
 * 评估依据（标准、法规、实践指南、国际框架）登记表。
 *
 * 规则：
 * - 只登记核过官方原文或官方公示页的依据；verified=false 的依据不得写进报告「评估依据」。
 * - 国际框架只作攻击手法与对照参考，不作为合规依据。
 * - 在研标准必须带「在研、非现行」字样（statusNote），报告原样带出。
 *
 * 核对记录见 docs/standards/README.md（2026-11-13 核对）。
 */

export type BasisKind =
  | 'law'
  | 'regulation'
  | 'policy'
  | 'national_standard'
  | 'national_standard_plan'
  | 'guiding_document'
  | 'practice_guide'
  | 'technical_document'
  | 'international';

export type BasisStatus =
  /** 现行（已实施）。 */
  | 'in_force'
  /** 已发布（实践指南、技术文件等无实施日期的文件）。 */
  | 'published'
  /** 在研（国家标准计划已下达，正在起草）。 */
  | 'drafting'
  /** 公开征求意见中或征求意见稿。 */
  | 'consultation'
  /** 国际框架，仅作参考。 */
  | 'reference';

export interface StandardBasis {
  id: string;
  /** 编号，例如 GB/T 45654-2025；没有编号的留空。 */
  code?: string;
  title: string;
  kind: BasisKind;
  status: BasisStatus;
  issuer: string;
  /** 发布、实施或下达日期的说明文字。 */
  date: string;
  /** 报告里紧跟依据名称的一句状态说明，例如「在研强制性国家标准，非现行」。 */
  statusNote?: string;
  /** 是否核过官方原文或官方公示页。 */
  verified: boolean;
  /** 官方出处（核对用，不进报告正文）。 */
  source?: string;
}

export const BASIS_KIND_LABELS: Record<BasisKind, string> = {
  law: '法律',
  regulation: '部门规章',
  policy: '政策文件',
  national_standard: '国家标准',
  national_standard_plan: '国家标准计划（在研）',
  guiding_document: '国家标准化指导性技术文件',
  practice_guide: '网络安全标准实践指南',
  technical_document: '技术文件',
  international: '国际框架（参考）',
};

export const BASIS_STATUS_LABELS: Record<BasisStatus, string> = {
  in_force: '现行',
  published: '已发布',
  drafting: '在研',
  consultation: '征求意见',
  reference: '参考',
};

export const STANDARD_BASES: readonly StandardBasis[] = [
  {
    id: 'gbt45654',
    code: 'GB/T 45654-2025',
    title: '网络安全技术 生成式人工智能服务安全基本要求',
    kind: 'national_standard',
    status: 'in_force',
    issuer: '国家市场监督管理总局、国家标准化管理委员会',
    date: '2025-04-25 发布，2025-11-01 实施',
    verified: true,
    source: 'std.samr.gov.cn；由 TC260-003 技术文件转化',
  },
  {
    id: 'gb45438',
    code: 'GB 45438-2025',
    title: '网络安全技术 人工智能生成合成内容标识方法',
    kind: 'national_standard',
    status: 'in_force',
    issuer: '国家市场监督管理总局、国家标准化管理委员会',
    date: '2025-09-01 实施',
    statusNote: '强制性国家标准',
    verified: true,
  },
  {
    id: 'genai-measures',
    title: '生成式人工智能服务管理暂行办法',
    kind: 'regulation',
    status: 'in_force',
    issuer: '国家网信办等七部门',
    date: '2023-08-15 施行',
    verified: true,
  },
  {
    id: 'aigc-label-measures',
    title: '人工智能生成合成内容标识办法',
    kind: 'regulation',
    status: 'in_force',
    issuer: '国家网信办等四部门',
    date: '2025-09-01 施行',
    verified: true,
  },
  {
    id: 'anthropomorphic-measures',
    title: '人工智能拟人化互动服务管理暂行办法',
    kind: 'regulation',
    status: 'in_force',
    issuer: '国家网信办、国家发展改革委、工业和信息化部、公安部、国家市场监督管理总局（令第 21 号）',
    date: '2026-04-10 公布，2026-07-15 施行',
    statusNote: '仅适用于提供持续性情感互动的拟人化互动服务',
    verified: true,
    source: 'www.cac.gov.cn/2026-04/10/c_1777558395078289.htm',
  },
  {
    id: 'agent-app-security-plan',
    code: '国家标准计划 20263116-Q-252',
    title: '智能体应用安全基本要求',
    kind: 'national_standard_plan',
    status: 'drafting',
    issuer: '全国网络安全标准化技术委员会归口，中国电子技术标准化研究院起草',
    date: '2026-06-27 下达，项目周期 18 个月',
    statusNote: '在研强制性国家标准，非现行；本平台参照其公示的主要技术内容组织测评项',
    verified: true,
    source: 'std.samr.gov.cn/gb/search/gbDetailedCNF?id=4C5277928DA2411EE06397BE0A0AE436',
  },
  {
    id: 'tc260-pg-20266a',
    code: 'TC260-PG-20266A',
    title: '网络安全标准实践指南——智能体部署使用安全指引',
    kind: 'practice_guide',
    status: 'published',
    issuer: '全国网络安全标准化技术委员会秘书处',
    date: '2026-07-01 发布（v1.0-202607）',
    verified: true,
    source: 'www.tc260.org.cn/tc260/tzgg/202607/98b6f259f8a3428b8fe1cfea3c0fb19e.shtml',
  },
  {
    id: 'tc260-agent-dev-guide',
    title: '网络安全标准实践指南——智能体系统开发安全指南（征求意见稿）',
    kind: 'practice_guide',
    status: 'consultation',
    issuer: '全国网络安全标准化技术委员会秘书处',
    date: '2026-09 公开征求意见',
    statusNote: '征求意见稿，非正式发布',
    verified: true,
    source: 'www.tc260.org.cn/tc260/tzgg/202609/e5b82ae7aca244d19d36b39575cbb458.shtml',
  },
  {
    id: 'gbz185',
    code: 'GB/Z 185-2026 系列',
    title: '人工智能 智能体互联',
    kind: 'guiding_document',
    status: 'in_force',
    issuer: '国家市场监督管理总局、国家标准化管理委员会',
    date: '2026-05-22 发布',
    statusNote: '国家标准化指导性技术文件',
    verified: true,
  },
  {
    id: 'agent-terminal-notice',
    code: '工信厅信管〔2026〕42号',
    title: '关于加强智能体终端设备进网管理的通知',
    kind: 'policy',
    status: 'in_force',
    issuer: '工业和信息化部办公厅',
    date: '2026-10-24',
    statusNote: '适用于预置智能体的手机、平板、可穿戴设备等电信终端',
    verified: true,
  },
  {
    id: 'owasp-llm-2025',
    title: 'OWASP Top 10 for LLM Applications 2025',
    kind: 'international',
    status: 'reference',
    issuer: 'OWASP',
    date: '2024-11',
    verified: true,
  },
  {
    id: 'owasp-asi-2026',
    title: 'OWASP Top 10 for Agentic Applications 2026',
    kind: 'international',
    status: 'reference',
    issuer: 'OWASP',
    date: '2025-12',
    verified: true,
  },
  {
    id: 'mitre-atlas',
    title: 'MITRE ATLAS（人工智能系统对抗威胁矩阵）',
    kind: 'international',
    status: 'reference',
    issuer: 'MITRE',
    date: '持续更新',
    verified: true,
  },
];

const BASIS_BY_ID = new Map(STANDARD_BASES.map((b) => [b.id, b]));

export function getBasis(id: string): StandardBasis | undefined {
  return BASIS_BY_ID.get(id);
}

/** 报告里展示的依据全称，例如「GB/T 45654-2025《网络安全技术 生成式人工智能服务安全基本要求》」。 */
export function basisDisplayName(basis: StandardBasis): string {
  return basis.code ? `${basis.code}《${basis.title}》` : `《${basis.title}》`;
}

/** 依据全称加状态说明，例如「…《智能体应用安全基本要求》（在研强制性国家标准，非现行…）」。 */
export function basisDisplayLine(basis: StandardBasis): string {
  const name = basisDisplayName(basis);
  return basis.statusNote ? `${name}（${basis.statusNote}）` : name;
}
