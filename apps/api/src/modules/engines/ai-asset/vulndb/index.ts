/**
 * AI 组件依赖漏洞匹配：解析依赖清单 → 查离线漏洞库（AI-Infra-Guard + OSV 中 AI 相关包）→ 按包合并。
 *
 * 确定性：
 * - CONFIRMED：清单/锁文件给出精确版本，且该版本满足漏洞规则。
 * - POSSIBLE：范围约束（>=、~=、^、~、==x.*）的“下界版本”满足漏洞规则，即该范围允许安装
 *   受影响版本；实际安装版本未知，所以降级。无下界（*、latest、仅 <）的范围不报，否则库里
 *   该包的每一条历史漏洞都会命中，结果不可用。
 * 版本号或规则无法解析时（求值为 null）不报。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateRule, parseRule, type RuleAst } from './version-expr.js';
import { parseManifest, normalizePypiName, type ManifestDependency } from './manifests.js';
import {
  SEVERITY_RANK,
  type AigVulnDataFile,
  type AigVulnRecord,
  type VulnSeverity,
  type VulnSourceKey,
} from './types.js';

export type { ManifestDependency } from './manifests.js';
export type { AigVulnRecord, VulnSeverity } from './types.js';

export type VulnCertainty = 'CONFIRMED' | 'POSSIBLE';

export interface VulnMatchAdvisory {
  id: string;
  cve: string | null;
  severity: VulnSeverity;
  title: string;
  remediation: string;
  rule: string;
  references: string[];
  sourcePath: string;
  /** 该条公告的数据来源标签。 */
  source: string;
}

export interface VulnMatch {
  ecosystem: 'pypi' | 'npm';
  packageName: string;
  /** 精确版本，或范围约束原文。 */
  version: string;
  versionKind: 'exact' | 'range';
  file: string;
  line: number;
  cves: string[];
  highestSeverity: VulnSeverity;
  /** 最高严重度那条漏洞的中文标题与修复建议。 */
  title: string;
  remediation: string;
  certainty: VulnCertainty;
  advisories: VulnMatchAdvisory[];
  /** 命中公告的数据来源标签，多个来源以「；」分隔。 */
  source: string;
}

export const VULNDB_FILE = fileURLToPath(new URL('./data/aig-vulns.json', import.meta.url));

interface IndexedRecord {
  record: AigVulnRecord;
  ast: RuleAst;
}

interface LoadedDb {
  data: AigVulnDataFile;
  byPackage: Map<string, IndexedRecord[]>;
  sourceLabels: Map<VulnSourceKey, string>;
}

/** 来源标签：名称（许可证）@ 上游版本（AIG 取 commit 前 12 位，OSV 取拉取日期）。 */
export function sourceLabelOf(meta: AigVulnDataFile['meta'], key: VulnSourceKey): string {
  const s = meta.sources.find((x) => x.key === key);
  if (!s) return key;
  if (key === 'aig') return `AI-Infra-Guard 漏洞库（${s.license}）@${s.version.slice(0, 12)}`;
  const label = key === 'osv-pypi' ? 'OSV PyPI 公告' : 'OSV npm 公告';
  return `${label}（${s.license}）@${s.fetchedAt.slice(0, 10)}`;
}

let cached: LoadedDb | null = null;

const keyOf = (ecosystem: string, name: string) =>
  `${ecosystem}:${ecosystem === 'pypi' ? normalizePypiName(name) : name.toLowerCase()}`;

export function loadVulnDb(file = VULNDB_FILE): LoadedDb {
  if (cached && file === VULNDB_FILE) return cached;
  const data = JSON.parse(readFileSync(file, 'utf8')) as AigVulnDataFile;
  const byPackage = new Map<string, IndexedRecord[]>();
  for (const record of data.records) {
    if (!record.package) continue;
    const parsed = parseRule(record.rule);
    if (parsed.kind !== 'version') continue;
    const key = keyOf(record.package.ecosystem, record.package.name);
    const list = byPackage.get(key) ?? [];
    list.push({ record, ast: parsed.ast });
    byPackage.set(key, list);
  }
  const sourceLabels = new Map<VulnSourceKey, string>(
    data.meta.sources.map((s) => [s.key, sourceLabelOf(data.meta, s.key)]),
  );
  const db = { data, byPackage, sourceLabels };
  if (file === VULNDB_FILE) cached = db;
  return db;
}

/**
 * 从范围约束里取“下界版本”：>=X、~=X、^X、~X、==X.*、X.x。
 * >X（开区间）、<X、*、tag、URL 没有可用下界，返回 null（不报）。
 */
export function rangeLowerBound(spec: string): string | null {
  const parts = spec.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const m = /^(>=|~=|\^|~|==|=)?v?(\d+(?:\.\d+)*[A-Za-z0-9+-]*)(?:\.\*|\.x)?$/.exec(part);
    if (m?.[2]) return m[2];
  }
  return null;
}

export function matchDependencies(deps: ManifestDependency[], db = loadVulnDb()): VulnMatch[] {
  const out: VulnMatch[] = [];
  for (const dep of deps) {
    const candidates = db.byPackage.get(keyOf(dep.ecosystem, dep.name));
    if (!candidates) continue;
    const probe = dep.versionKind === 'exact' ? dep.version : rangeLowerBound(dep.version);
    if (!probe) continue;
    const hits = candidates.filter((c) => evaluateRule(c.ast, probe) === true).map((c) => c.record);
    if (hits.length === 0) continue;
    hits.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id));
    const top = hits[0] as AigVulnRecord;
    const label = (r: AigVulnRecord) => db.sourceLabels.get(r.source) ?? r.source;
    out.push({
      ecosystem: dep.ecosystem,
      packageName: dep.name,
      version: dep.version,
      versionKind: dep.versionKind,
      file: dep.file,
      line: dep.line,
      cves: [...new Set(hits.map((h) => h.cve ?? h.id))],
      highestSeverity: top.severity,
      title: top.title,
      remediation: top.remediation,
      certainty: dep.versionKind === 'exact' ? 'CONFIRMED' : 'POSSIBLE',
      advisories: hits.map((h) => ({
        id: h.id,
        cve: h.cve,
        severity: h.severity,
        title: h.title,
        remediation: h.remediation,
        rule: h.rule,
        references: h.references,
        sourcePath: h.sourcePath,
        source: label(h),
      })),
      source: [...new Set(hits.map(label))].join('；'),
    });
  }
  return out;
}

/** 对上传的一组文件做依赖漏洞匹配；同一文件里同一包只出一条（多条 CVE 合并）。 */
export function matchDependencyVulns(files: { path: string; content: string }[]): VulnMatch[] {
  const seen = new Set<string>();
  const deps: ManifestDependency[] = [];
  for (const file of files) {
    for (const dep of parseManifest(file.path, file.content)) {
      const key = `${dep.file}\u0000${keyOf(dep.ecosystem, dep.name)}\u0000${dep.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push(dep);
    }
  }
  return matchDependencies(deps);
}
