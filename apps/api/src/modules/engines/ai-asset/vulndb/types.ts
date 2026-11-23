/** 漏洞库数据文件（data/aig-vulns.json）的结构；导入脚本写、运行时只读。 */
import type { PackageRef } from './packages.js';

export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** aig = AI-Infra-Guard data/vuln；osv-pypi / osv-npm = OSV 里 AI 相关包的 GHSA、PYSEC 公告。 */
export type VulnSourceKey = 'aig' | 'osv-pypi' | 'osv-npm';

export interface AigVulnRecord {
  /** 主编号：CVE 优先，其次 GHSA。 */
  id: string;
  cve: string | null;
  /** AIG 为 data/vuln 下的组件目录名；OSV 为包名。 */
  component: string;
  /** info.name 原文。 */
  componentName: string;
  aliases: string[];
  /** 归属的包；null = 无法确定包名映射，不参与依赖匹配。 */
  package: PackageRef | null;
  title: string;
  details: string;
  /** 匹配和展示用的严重度；与 GHSA 重叠的 AIG 条目取 AIG 的。 */
  severity: VulnSeverity;
  /** GitHub Advisory Database 给出的等级（有就存，不参与匹配和展示）。 */
  ghsaSeverity?: Exclude<VulnSeverity, 'UNKNOWN'>;
  cvss: string | null;
  /** 版本规则表达式，运行时用 version-expr 安全解析。 */
  rule: string;
  /** rule 改用 OSV 同包同编号公告的范围时，该公告的 sourcePath；没有则是本条目自己的规则。 */
  ruleSourcePath?: string;
  remediation: string;
  references: string[];
  /** AIG 为仓库内文件路径；OSV 为 osv:<生态>/<公告编号>。 */
  sourcePath: string;
  source: VulnSourceKey;
  /** 该漏洞在上游的全部编号（含主编号，及去重时并入的 GHSA、PYSEC、CVE）。 */
  advisoryIds: string[];
}

export interface VulnSourceMeta {
  key: VulnSourceKey;
  name: string;
  repository: string;
  /** SPDX 标识。 */
  license: string;
  /** 署名声明（按许可证要求保留）。 */
  notice: string;
  /** 上游版本：AIG 为 commit；OSV 为数据包的 Last-Modified 与 sha256，或查询接口的拉取时间。 */
  version: string;
  /** 拉取时间（ISO 8601）。 */
  fetchedAt: string;
  /** 本来源在最终数据里的条数（去重后）。 */
  records: number;
  /** 转换过程的计数：读入、跳过原因等。 */
  counts: Record<string, number>;
}

export interface AigVulnMeta {
  generatedAt: string;
  importScript: string;
  dedupe: string;
  sources: VulnSourceMeta[];
  counts: {
    total: number;
    withPackage: number;
    duplicatesRemoved: number;
    packageFilledFromOsv: number;
    /** AIG 条目没有包名、又不允许补包名时，单独保留的 OSV 条目数。 */
    keptUnfilled: number;
    /** AIG 条目的版本范围改用 OSV 同包同编号公告的条数。 */
    rulesFromOsv: number;
    /** 其中 OSV 与 AIG 判定不同的组数。 */
    ruleConflicts: number;
  };
  packages: Array<{ ecosystem: string; name: string; records: number }>;
}

export interface AigVulnDataFile {
  meta: AigVulnMeta;
  records: AigVulnRecord[];
}

const SEVERITY_ALIASES: Record<string, VulnSeverity> = {
  critical: 'CRITICAL',
  严重: 'CRITICAL',
  危急: 'CRITICAL',
  high: 'HIGH',
  高: 'HIGH',
  高危: 'HIGH',
  medium: 'MEDIUM',
  moderate: 'MEDIUM',
  中: 'MEDIUM',
  中等: 'MEDIUM',
  中危: 'MEDIUM',
  low: 'LOW',
  低: 'LOW',
  低危: 'LOW',
};

export function normalizeSeverity(raw: unknown): VulnSeverity {
  if (typeof raw !== 'string') return 'UNKNOWN';
  return SEVERITY_ALIASES[raw.trim().toLowerCase()] ?? 'UNKNOWN';
}

export const SEVERITY_RANK: Record<VulnSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNKNOWN: 0,
};
