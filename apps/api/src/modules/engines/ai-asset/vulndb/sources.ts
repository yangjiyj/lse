/**
 * 漏洞库多来源合并（导入期使用，纯函数）：
 * - AI-Infra-Guard（AIG）data/vuln：中文条目，导入逻辑见 scripts/update-aig-vulns.ts；
 * - OSV（osv.dev）里 AI 相关 PyPI / npm 包的 GHSA、PYSEC 条目。
 *
 * 只转换上游已有的内容，不补写漏洞：编号取上游的 CVE / GHSA，受影响范围取上游的
 * introduced / fixed / last_affected，修复建议只复述上游给出的修复版本。
 */
import { normalizePypiName } from './manifests.js';
import type { Ecosystem, PackageRef } from './packages.js';
import { normalizeSeverity, type AigVulnRecord, type VulnSourceKey } from './types.js';
import { evaluateRule, parseRule } from './version-expr.js';
import { parseVersion } from './version.js';

const CVE_RE = /^CVE-\d{4}-\d{4,}$/i;
const GHSA_RE = /^GHSA(-[0-9a-z]{4}){3}$/i;
const GHSA_IN_TEXT_RE = /GHSA(?:-[0-9a-z]{4}){3}/gi;
const MAX_DETAILS = 4000;
const MAX_REFERENCES = 10;
const MAX_EXPLICIT_VERSIONS = 50;

export function normalizeAdvisoryId(raw: string): string {
  const text = raw.trim();
  if (CVE_RE.test(text)) return text.toUpperCase();
  if (GHSA_RE.test(text)) return `GHSA-${text.slice(5).toLowerCase()}`;
  return text;
}

/** 从一组编号里取主编号：CVE 优先，其次 GHSA；都没有返回 null。 */
export function advisoryIdOf(ids: string[]): {
  id: string | null;
  cve: string | null;
  ghsa: string | null;
} {
  const norm = ids.map(normalizeAdvisoryId);
  const cve = norm.find((i) => CVE_RE.test(i)) ?? null;
  const ghsa = norm.find((i) => GHSA_RE.test(i)) ?? null;
  return { id: cve ?? ghsa, cve, ghsa };
}

/** 文本里只出现一个 GHSA 编号时返回它（多于一个说明是相关公告，不取）。 */
export function singleGhsaIn(texts: string[]): string | null {
  const found = new Set<string>();
  for (const t of texts)
    for (const m of t.matchAll(GHSA_IN_TEXT_RE)) found.add(normalizeAdvisoryId(m[0]));
  return found.size === 1 ? [...found][0]! : null;
}

export function normalizeComponent(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.\s]+/g, '-');
}

/**
 * 同一产品在 AIG 目录名与发布包名上的不同叫法（规整后的名字 → 包名）。
 * 依据：OSV 对同一 CVE 给出的受影响包与 AIG 目录指向同一项目。
 */
export const COMPONENT_ALIASES: Record<string, string> = {
  chuanhugpt: 'chuanhuchatgpt', // github.com/GaiZhenbiao/ChuanhuChatGPT，PyPI chuanhuchatgpt
  'mcp-inspector': '@modelcontextprotocol/inspector', // github.com/modelcontextprotocol/inspector
  'jupyter-notebook': 'notebook', // Jupyter Notebook 的 PyPI 包名为 notebook
};

/** 包的口径：「生态:包名」，PyPI 包名按 PEP 503 规整，npm 包名只转小写。 */
export function packageKey(pkg: PackageRef): string {
  const name =
    pkg.ecosystem === 'pypi' ? normalizePypiName(pkg.name) : pkg.name.trim().toLowerCase();
  return `${pkg.ecosystem}:${name}`;
}

/** 目录名口径：小写、-_. 和空白统一成 -，再按别名表归一。 */
function dirKey(name: string): string {
  const key = normalizeComponent(name);
  return COMPONENT_ALIASES[key] ?? key;
}

/**
 * 去重用的组件口径：有包名用「生态:包名」（PyPI 与 npm 的同名包是两个组件），
 * 没有包名用组件目录名（见 dirKey）。
 */
export function componentKey(record: Pick<AigVulnRecord, 'package' | 'component'>): string {
  return record.package ? packageKey(record.package) : dirKey(record.component);
}

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvAffected {
  package?: { ecosystem?: string; name?: string; purl?: string };
  ranges?: Array<{ type?: string; events?: OsvEvent[] }>;
  versions?: string[];
}

export interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  withdrawn?: string;
  modified?: string;
  published?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: OsvAffected[];
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: Record<string, unknown>;
}

const quoteOk = (v: string) => !!v && !/["\\]/.test(v) && v.length <= 64;
const versionOk = (v: string) => quoteOk(v) && parseVersion(v) !== null;

/**
 * OSV affected[] 单项 → 版本规则（与 AIG rule 同一语法）。
 * 只认 ECOSYSTEM / SEMVER 范围；introduced 为 0 表示无下界；fixed → <，last_affected → <=。
 * 没有范围时退回显式版本列表。任何边界版本无法解析即返回 null（不收）。
 */
export function osvRule(affected: OsvAffected): string | null {
  const clauses: string[] = [];
  for (const range of affected.ranges ?? []) {
    if (range.type !== 'ECOSYSTEM' && range.type !== 'SEMVER') continue;
    let lower: string | null = null;
    let open = false;
    const close = (upper: string | null) => {
      const parts: string[] = [];
      if (lower !== null && lower !== '0') parts.push(`version >= "${lower}"`);
      if (upper) parts.push(upper);
      if (!parts.length) parts.push('version >= "0"');
      clauses.push(parts.length > 1 ? `(${parts.join(' && ')})` : parts[0]!);
      open = false;
      lower = null;
    };
    for (const ev of range.events ?? []) {
      if (ev.introduced !== undefined) {
        if (open) close(null);
        if (ev.introduced !== '0' && !versionOk(ev.introduced)) return null;
        lower = ev.introduced;
        open = true;
      } else if (ev.fixed !== undefined || ev.last_affected !== undefined) {
        const v = (ev.fixed ?? ev.last_affected)!;
        if (!versionOk(v)) return null;
        if (!open) continue;
        close(ev.fixed !== undefined ? `version < "${v}"` : `version <= "${v}"`);
      }
    }
    if (open) close(null);
  }
  if (clauses.length) {
    // 只有一个子句时去掉多余括号
    if (clauses.length === 1) return clauses[0]!.replace(/^\((.*)\)$/, '$1');
    return clauses.join(' || ');
  }
  const versions = (affected.versions ?? []).filter((v) => v.trim());
  if (!versions.length || versions.length > MAX_EXPLICIT_VERSIONS) return null;
  if (!versions.every(versionOk)) return null;
  return versions.map((v) => `version == "${v}"`).join(' || ');
}

function fixedVersions(affected: OsvAffected[]): string[] {
  const out = new Set<string>();
  for (const a of affected)
    for (const r of a.ranges ?? [])
      for (const ev of r.events ?? []) if (ev.fixed && quoteOk(ev.fixed)) out.add(ev.fixed);
  return [...out];
}

function osvSeverity(osv: OsvRecord) {
  const level = normalizeSeverity(osv.database_specific?.severity);
  const vectors = (osv.severity ?? [])
    .map((s) => (typeof s.score === 'string' ? s.score.trim() : ''))
    .filter((s) => s.startsWith('CVSS:'));
  return {
    severity: level,
    cvss: vectors.find((v) => v.startsWith('CVSS:3')) ?? vectors[0] ?? null,
  };
}

export interface OsvConvertOptions {
  ecosystem: Ecosystem;
  /** 包名（PyPI 已规整）是否属于收录范围。 */
  accept: (name: string) => boolean;
  source: VulnSourceKey;
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { pypi: 'PyPI', npm: 'npm' };

/** 参与合并的记录：relatedIds 只用于判重，不并入编号、不写进数据文件。 */
export type MergeCandidate = AigVulnRecord & { relatedIds?: string[] };

const isKnownId = (i: string) => CVE_RE.test(i) || GHSA_RE.test(i) || /^PYSEC-/i.test(i);

/**
 * 一条 OSV 公告 → 每个受影响的收录包一条记录；撤回的、没有 CVE/GHSA 编号的、范围无法转换的不收。
 * 别名里有多个 CVE 的公告说不清对应哪一个 CVE（上游别名会传递连成一片）：主编号用公告自己的
 * GHSA 编号，别名只用来判重；公告自己不是 GHSA 的不收。
 */
export function osvToRecords(osv: OsvRecord, opts: OsvConvertOptions): MergeCandidate[] {
  if (osv.withdrawn) return [];
  const ownId = normalizeAdvisoryId(osv.id);
  const allIds = [...new Set([ownId, ...(osv.aliases ?? []).map(normalizeAdvisoryId)])].filter(
    isKnownId,
  );
  const ambiguous = allIds.filter((i) => CVE_RE.test(i)).length > 1;
  if (ambiguous && !GHSA_RE.test(ownId)) return [];
  const { id, cve } = ambiguous ? { id: ownId, cve: null } : advisoryIdOf(allIds);
  if (!id) return [];
  const advisoryIds = ambiguous ? [ownId] : allIds;
  const relatedIds = ambiguous ? allIds.filter((i) => i !== ownId) : undefined;
  const byPackage = new Map<string, OsvAffected[]>();
  for (const a of osv.affected ?? []) {
    if (a.package?.ecosystem !== OSV_ECOSYSTEM[opts.ecosystem] || !a.package.name) continue;
    const name =
      opts.ecosystem === 'pypi' ? normalizePypiName(a.package.name) : a.package.name.trim();
    if (!opts.accept(name)) continue;
    byPackage.set(name, [...(byPackage.get(name) ?? []), a]);
  }
  const { severity, cvss } = osvSeverity(osv);
  // database_specific.severity 只有 GHSA 公告才是 GitHub 给的等级
  const ghsaSeverity = GHSA_RE.test(ownId) && severity !== 'UNKNOWN' ? severity : undefined;
  const references = [
    `https://osv.dev/vulnerability/${osv.id}`,
    ...(osv.references ?? [])
      .map((r) => (typeof r.url === 'string' ? r.url.trim() : ''))
      .filter((u) => /^https?:\/\//.test(u)),
  ];
  const out: MergeCandidate[] = [];
  for (const [name, list] of byPackage) {
    const rules = list.map(osvRule);
    if (rules.some((r) => r === null)) continue;
    const rule = rules.length === 1 ? rules[0]! : rules.map((r) => `(${r})`).join(' || ');
    const fixed = fixedVersions(list);
    const pkg: PackageRef = { ecosystem: opts.ecosystem, name };
    out.push({
      id,
      cve,
      component: name,
      componentName: name,
      aliases: [],
      package: pkg,
      title: (osv.summary ?? '').trim() || id,
      details: (osv.details ?? '').trim().slice(0, MAX_DETAILS),
      severity,
      ...(ghsaSeverity ? { ghsaSeverity } : {}),
      cvss,
      rule,
      remediation: fixed.length
        ? `升级 ${name} 至 ${fixed.join(' / ')} 或更高版本（以上游公告为准）。`
        : '上游公告未给出修复版本，请关注官方公告。',
      references: [...new Set(references)].slice(0, MAX_REFERENCES),
      sourcePath: `osv:${OSV_ECOSYSTEM[opts.ecosystem]}/${osv.id}`,
      source: opts.source,
      advisoryIds: [...advisoryIds],
      ...(relatedIds ? { relatedIds } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 合并去重
// ---------------------------------------------------------------------------

export const DEDUPE_RULE =
  '按「编号 + 组件」去重：组件有包名时为「生态:包名」（PyPI 与 npm 的同名包是两个组件），没有包名时为组件目录名' +
  '（小写，-_. 统一为 -，同一产品的不同叫法按别名表归一）；同一组件下任一编号（CVE、GHSA、PYSEC）相同即视为同一条漏洞。' +
  '保留顺序：AIG（中文，带修复建议）> OSV GHSA > OSV PYSEC；被去掉的条目只把尚未归属其他条目的编号并入保留条目；' +
  '别名里有多个 CVE 的 OSV 公告只用于判重，不并编号、不改范围。' +
  'AIG 条目没有包名、OSV 同编号的同名包给出包名时：允许补映射的（AIG 目录没有包名映射）用该包名补上；' +
  '不允许的（目录有映射、条目被判为不属于该包）不改判，OSV 条目单独保留。' +
  '同包同编号时版本范围以 OSV 为准（先 GHSA 后 PYSEC），OSV 没有可用范围时才用 AIG 的 rule；' +
  '标题、详情、修复建议、严重度仍取 AIG，GHSA 给出的等级另存 ghsaSeverity。';

export interface MergeResult {
  records: AigVulnRecord[];
  duplicates: number;
  /** AIG 条目借 OSV 同编号补上包名的条数。 */
  packageFilled: number;
  /** 保留条目没有包名、又不允许补包名时，单独保留的带包名条目数。 */
  keptUnfilled: number;
  /** AIG 条目的版本范围改用 OSV 同包同编号公告的条数。 */
  rulesFromOsv: number;
  /** 其中 OSV 与 AIG 判定不同的组数（见 rulesDisagree）。 */
  ruleConflicts: number;
}

export interface MergeOptions {
  /** 保留条目没有包名、重复条目有包名时，是否用它补映射；默认允许。 */
  canFillPackage?: (kept: AigVulnRecord) => boolean;
}

/** 比对用的版本点：两条规则里出现的边界版本，及其末位加一、减一；另加几个常见版本。 */
function probeVersions(rules: string[]): string[] {
  const out = new Set(['0.0.1', '0.1.0', '1.0.0', '99999.0.0']);
  for (const rule of rules) {
    for (const m of rule.matchAll(/"([^"]+)"/g)) {
      const parsed = parseVersion(m[1]!);
      // 版本 0 在 OSV 里表示“从最早的版本起”，不当真实版本比
      if (!parsed || parsed.release.every((n) => n === 0)) continue;
      out.add(m[1]!);
      const rel = parsed.release;
      const last = rel.length - 1;
      out.add([...rel.slice(0, last), rel[last]! + 1].join('.'));
      if (rel[last]! > 0) out.add([...rel.slice(0, last), rel[last]! - 1].join('.'));
    }
  }
  return [...out];
}

/** 两条版本规则在边界附近的版本上判定是否不同（写法不同、判定相同不算）。 */
export function rulesDisagree(a: string, b: string): boolean {
  const x = parseRule(a);
  const y = parseRule(b);
  if (x.kind !== 'version' || y.kind !== 'version') return a.trim() !== b.trim();
  return probeVersions([a, b]).some((v) => evaluateRule(x.ast, v) !== evaluateRule(y.ast, v));
}

/**
 * groups 按优先级从高到低排列；组内按给定顺序，先到先留。
 * 带包名的条目先在同包里找同编号；找不到再看同名目录下没有包名的保留条目，能补包名就补，
 * 不能补就单独保留，不丢。
 */
export function mergeRecords(groups: MergeCandidate[][], opts: MergeOptions = {}): MergeResult {
  const kept: AigVulnRecord[] = [];
  /** componentKey → 编号 → 保留条目。 */
  const index = new Map<string, Map<string, AigVulnRecord>>();
  let duplicates = 0;
  let packageFilled = 0;
  let keptUnfilled = 0;
  let rulesFromOsv = 0;
  let ruleConflicts = 0;

  const bucket = (key: string) => {
    const byId = index.get(key) ?? new Map<string, AigVulnRecord>();
    index.set(key, byId);
    return byId;
  };
  /** 按 ids 顺序对上的全部保留条目（去重）。 */
  const lookupAll = (key: string, ids: string[]) => {
    const byId = index.get(key);
    const found = ids.map((i) => byId?.get(i)).filter((r): r is AigVulnRecord => !!r);
    return [...new Set(found)];
  };
  const lookup = (key: string, ids: string[]) => lookupAll(key, ids)[0];
  /** 已归属其他条目的编号不改归属。 */
  const claim = (key: string, record: AigVulnRecord, ids: string[]) => {
    const byId = bucket(key);
    for (const i of ids) {
      if (byId.has(i)) continue;
      if (!record.advisoryIds.includes(i)) record.advisoryIds.push(i);
      byId.set(i, record);
    }
  };
  /** 同包同编号的 OSV 公告：版本范围以它为准（先到的为准），GHSA 等级另存。 */
  const adoptOsv = (existing: AigVulnRecord, input: AigVulnRecord) => {
    if (!existing.ghsaSeverity && input.ghsaSeverity) existing.ghsaSeverity = input.ghsaSeverity;
    if (existing.source === 'aig' && input.source !== 'aig' && !existing.ruleSourcePath) {
      if (rulesDisagree(existing.rule, input.rule)) ruleConflicts += 1;
      existing.rule = input.rule;
      existing.ruleSourcePath = input.sourcePath;
      rulesFromOsv += 1;
    }
  };
  /** 同包同编号的重复条目并入保留条目。 */
  const absorb = (existing: AigVulnRecord, input: AigVulnRecord, ids: string[]) => {
    const key = componentKey(existing);
    claim(key, existing, ids);
    if (!existing.cve && input.cve && index.get(key)?.get(input.cve) === existing)
      existing.cve = input.cve;
    adoptOsv(existing, input);
  };

  for (const group of groups) {
    for (const { relatedIds = [], ...input } of group) {
      const key = componentKey(input);
      const ids = [...new Set([...input.advisoryIds, input.id].map(normalizeAdvisoryId))];
      const related = relatedIds.map(normalizeAdvisoryId);

      // AIG 同一漏洞可能分成 CVE、GHSA 两个文件：并入第一条，其余同包条目也用这条公告的范围
      const [same, ...alsoSame] = lookupAll(key, ids);
      if (same || lookup(key, related)) {
        duplicates += 1;
        if (same) {
          // 只靠不确定的别名对上的公告只判重
          absorb(same, input, ids);
          for (const other of alsoSame) adoptOsv(other, input);
        }
        continue;
      }

      if (input.package) {
        const dir = dirKey(input.package.name);
        const unattributed = lookup(dir, ids);
        if (unattributed && (opts.canFillPackage?.(unattributed) ?? true)) {
          duplicates += 1;
          packageFilled += 1;
          const byDir = bucket(dir);
          for (const i of unattributed.advisoryIds)
            if (byDir.get(i) === unattributed) byDir.delete(i);
          unattributed.package = input.package;
          claim(key, unattributed, [...unattributed.advisoryIds]);
          absorb(unattributed, input, ids);
          continue;
        }
        if (unattributed || lookup(dir, related)) keptUnfilled += 1;
      }

      const record: AigVulnRecord = { ...input, advisoryIds: [] };
      kept.push(record);
      claim(key, record, ids);
    }
  }
  return { records: kept, duplicates, packageFilled, keptUnfilled, rulesFromOsv, ruleConflicts };
}
