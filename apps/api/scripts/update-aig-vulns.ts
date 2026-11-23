/**
 * 更新 AI 组件漏洞库 apps/api/src/modules/engines/ai-asset/vulndb/data/aig-vulns.json。
 *
 * 来源（只用公开、可追溯的数据，不补写任何条目）：
 *   1. Tencent Zhuque Lab AI-Infra-Guard 仓库 data/vuln（Apache-2.0）
 *   2. OSV PyPI 全量包 PyPI/all.zip 中 AI 相关包的 GHSA、PYSEC 公告（CC-BY-4.0）
 *   3. OSV 查询接口 /v1/query 中 AI 相关 npm 包的 GHSA 公告（CC-BY-4.0）
 * 收录的包见 vulndb/osv-packages.ts，去重口径见 vulndb/sources.ts 的 DEDUPE_RULE，
 * 来源与许可说明见 docs/ai-component-vulndb-sources.md。
 *
 * 用法（在 apps/api 下）：
 *   node --import tsx scripts/update-aig-vulns.ts --raw-dir <原始数据目录> [--offline | --reuse aig,osv-pypi,osv-npm]
 * 原始数据目录存放拉下来的上游数据（不进仓库）：aig-repo/、osv/PyPI-all.zip、osv/npm/*.json。
 * --offline 不联网，直接用目录里已有的数据重新生成；--reuse 只对列出的来源不联网。
 * 可重复运行；同一份原始数据得到同样的记录。
 * 依赖：git、python3 + PyYAML（读 AIG 的 YAML，见 aig-vulndb-yaml-dump.py）。
 * 请求 api.osv.dev 超时时（Node 默认的地址族自动选择在部分网络下连不上），关掉它再跑：
 *   node --no-network-family-autoselection --import tsx scripts/update-aig-vulns.ts …
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import {
  attributePackage,
  mappingForDir,
} from '../src/modules/engines/ai-asset/vulndb/attribution.js';
import { parseRule } from '../src/modules/engines/ai-asset/vulndb/version-expr.js';
import {
  DEDUPE_RULE,
  advisoryIdOf,
  mergeRecords,
  osvToRecords,
  singleGhsaIn,
  type OsvRecord,
} from '../src/modules/engines/ai-asset/vulndb/sources.js';
import {
  OSV_NPM_PACKAGES,
  acceptNpm,
  acceptPypi,
} from '../src/modules/engines/ai-asset/vulndb/osv-packages.js';
import {
  normalizeSeverity,
  type AigVulnDataFile,
  type AigVulnRecord,
  type VulnSourceMeta,
} from '../src/modules/engines/ai-asset/vulndb/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '../src/modules/engines/ai-asset/vulndb/data/aig-vulns.json');

const AIG_REPO_URL = 'https://github.com/Tencent/AI-Infra-Guard.git';
const OSV_PYPI_ZIP_URL = 'https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip';
const OSV_QUERY_URL = 'https://api.osv.dev/v1/query';

const AIG_NOTICE =
  'Based on Tencent Zhuque Lab AI-Infra-Guard (https://github.com/Tencent/AI-Infra-Guard). ' +
  'Copyright 2024-2026 Tencent Zhuque Lab. Licensed under the Apache License, Version 2.0.';
const OSV_NOTICE =
  'Vulnerability data from OSV (https://osv.dev), originally published by the GitHub Advisory Database ' +
  '(https://github.com/github/advisory-database) and the PyPI Advisory Database ' +
  '(https://github.com/pypa/advisory-database), licensed under CC BY 4.0 ' +
  '(https://creativecommons.org/licenses/by/4.0/). Changes: filtered to AI-related packages, ' +
  'converted affected ranges to rule expressions, de-duplicated, remediation text generated from fixed versions.';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const rawDir = path.resolve(
  arg('--raw-dir') ?? process.env.VULNDB_RAW_DIR ?? path.join(homedir(), '.cache/lse-vulndb'),
);
const offline = process.argv.includes('--offline');
const reuse = new Set(
  (arg('--reuse') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const isOffline = (key: 'aig' | 'osv-pypi' | 'osv-npm') => offline || reuse.has(key);
const aigDir = path.join(rawDir, 'aig-repo');
const osvDir = path.join(rawDir, 'osv');
const npmDir = path.join(osvDir, 'npm');
mkdirSync(npmDir, { recursive: true });

const git = (...args: string[]) =>
  execFileSync('git', ['-C', aigDir, ...args], { encoding: 'utf8' }).trim();
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function retry<T>(label: string, fn: () => Promise<T> | T, times = 3): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= times) throw new Error(`${label} 失败：${(err as Error).message}`);
      console.warn(`${label} 第 ${i} 次失败，重试：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

interface AigFetch {
  commit: string;
  fetchedAt: string;
}

async function fetchAig(): Promise<AigFetch> {
  const infoFile = path.join(rawDir, 'aig-fetch.json');
  if (!isOffline('aig')) {
    if (!existsSync(path.join(aigDir, '.git'))) {
      await retry('克隆 AI-Infra-Guard', () =>
        execFileSync(
          'git',
          ['clone', '--filter=blob:none', '--no-checkout', AIG_REPO_URL, aigDir],
          { stdio: 'inherit' },
        ),
      );
      git('sparse-checkout', 'set', '--no-cone', '/data/vuln/', '/LICENSE', '/NOTICE');
    } else {
      await retry('拉取 AI-Infra-Guard', () => git('fetch', '--quiet', 'origin', 'main'));
    }
    await retry('检出 AI-Infra-Guard', () => git('checkout', '--quiet', '--detach', 'origin/main'));
    writeJson(infoFile, { commit: git('rev-parse', 'HEAD'), fetchedAt: new Date().toISOString() });
  }
  if (!existsSync(infoFile)) {
    if (!existsSync(path.join(aigDir, '.git')))
      throw new Error(`没有 AI-Infra-Guard 数据：${aigDir}`);
    // 离线且没有拉取记录：以检出时间（.git/HEAD 修改时间）为拉取时间
    writeJson(infoFile, {
      commit: git('rev-parse', 'HEAD'),
      fetchedAt: statSync(path.join(aigDir, '.git/HEAD')).mtime.toISOString(),
    });
  }
  const info = readJson<AigFetch>(infoFile);
  if (git('rev-parse', 'HEAD') !== info.commit)
    throw new Error('aig-repo 当前提交与 aig-fetch.json 不一致');
  return info;
}

interface ZipFetch {
  url: string;
  lastModified: string;
  sha256: string;
  fetchedAt: string;
}

async function fetchPypiZip(): Promise<ZipFetch> {
  const zipFile = path.join(osvDir, 'PyPI-all.zip');
  const infoFile = path.join(osvDir, 'PyPI-all.json');
  if (!isOffline('osv-pypi')) {
    await retry('下载 OSV PyPI/all.zip', async () => {
      const res = await fetch(OSV_PYPI_ZIP_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(`${zipFile}.part`, buf);
      unzipSync(new Uint8Array(buf), { filter: () => false }); // 校验目录完整
      renameSync(`${zipFile}.part`, zipFile);
      const lm = res.headers.get('last-modified');
      writeJson(infoFile, {
        url: OSV_PYPI_ZIP_URL,
        lastModified: lm ? new Date(lm).toISOString() : '',
        sha256: sha256File(zipFile),
        fetchedAt: new Date().toISOString(),
      });
    });
  }
  if (!existsSync(zipFile)) throw new Error(`没有 OSV PyPI 数据：${zipFile}`);
  if (!existsSync(infoFile)) {
    // 离线且没有下载记录（例如用 curl -R 手动下载）：文件修改时间即服务端 Last-Modified
    const st = statSync(zipFile);
    writeJson(infoFile, {
      url: OSV_PYPI_ZIP_URL,
      lastModified: st.mtime.toISOString(),
      sha256: sha256File(zipFile),
      fetchedAt: st.ctime.toISOString(),
    });
  }
  const info = readJson<ZipFetch>(infoFile);
  if (sha256File(zipFile) !== info.sha256)
    throw new Error('PyPI-all.zip 与 PyPI-all.json 记录的 sha256 不一致');
  return info;
}

interface NpmCache {
  package: string;
  fetchedAt: string;
  vulns: OsvRecord[];
}

const npmCacheFile = (name: string) => path.join(npmDir, `${name.replace(/[@/]/g, '_')}.json`);

async function fetchNpm(): Promise<NpmCache[]> {
  const out: NpmCache[] = [];
  for (const name of OSV_NPM_PACKAGES) {
    const file = npmCacheFile(name);
    if (!isOffline('osv-npm')) {
      const vulns: OsvRecord[] = [];
      let pageToken: string | undefined;
      do {
        const body = {
          package: { name, ecosystem: 'npm' },
          ...(pageToken ? { page_token: pageToken } : {}),
        };
        const page = await retry(`查询 OSV npm ${name}`, async () => {
          const res = await fetch(OSV_QUERY_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as { vulns?: OsvRecord[]; next_page_token?: string };
        });
        vulns.push(...(page.vulns ?? []));
        pageToken = page.next_page_token;
      } while (pageToken);
      writeJson(file, { package: name, fetchedAt: new Date().toISOString(), vulns });
    }
    if (!existsSync(file)) throw new Error(`没有 OSV npm 数据：${file}`);
    out.push(readJson<NpmCache>(file));
  }
  return out;
}

// ---------------------------------------------------------------------------
// AIG 转换
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
function field(doc: Doc, key: string): unknown {
  const info = (doc.info ?? {}) as Doc;
  return info[key] ?? doc[key];
}

function convertAig(commit: string) {
  const raw = execFileSync(
    'python3',
    [path.join(here, 'aig-vulndb-yaml-dump.py'), aigDir, commit],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  ).toString('utf8');
  const lines = raw.split('\n').filter(Boolean);
  const counts = {
    files: 0,
    converted: 0,
    skippedEmptyRule: 0,
    skippedNonVersionRule: 0,
    skippedInvalidRule: 0,
    skippedParseError: 0,
    skippedNoId: 0,
  };
  const records: AigVulnRecord[] = [];
  for (const line of lines.slice(1)) {
    counts.files += 1;
    const row = JSON.parse(line) as { path: string; doc?: Doc; error?: string };
    if (row.error || !row.doc || typeof row.doc !== 'object') {
      counts.skippedParseError += 1;
      continue;
    }
    const doc = row.doc;
    const rule = str(doc.rule);
    const parsed = parseRule(rule);
    if (parsed.kind !== 'version') {
      if (parsed.kind === 'empty') counts.skippedEmptyRule += 1;
      else if (parsed.kind === 'non_version') counts.skippedNonVersionRule += 1;
      else counts.skippedInvalidRule += 1;
      continue;
    }
    const component = row.path.split('/')[2] ?? '';
    const fileName = path.basename(row.path).replace(/\.ya?ml$/, '');
    const references = Array.isArray(doc.references)
      ? doc.references.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
      : [];
    const ids = advisoryIdOf([str(field(doc, 'cve')), fileName]);
    const id = ids.id ?? singleGhsaIn(references);
    if (!id) {
      counts.skippedNoId += 1;
      continue;
    }
    const summary = str(field(doc, 'summary'));
    const details = str(field(doc, 'details'));
    const remediation = str(field(doc, 'security_advise'));
    const pkg = attributePackage({
      sourcePath: row.path,
      component,
      summary,
      details,
      remediation,
    });
    records.push({
      id,
      cve: ids.cve,
      component,
      componentName: str(field(doc, 'name')) || component,
      aliases: mappingForDir(component)?.aliases ?? [],
      package: pkg,
      title: summary || fileName,
      details,
      severity: normalizeSeverity(field(doc, 'severity')),
      cvss: str(field(doc, 'cvss')) || null,
      rule,
      remediation,
      references,
      sourcePath: row.path,
      source: 'aig',
      advisoryIds: [...new Set([id, ids.cve, ids.ghsa].filter((x): x is string => !!x))],
    });
    counts.converted += 1;
  }
  return { records, counts };
}

// ---------------------------------------------------------------------------
// OSV 转换
// ---------------------------------------------------------------------------

/** 别名里有多个 CVE、自身又不是 GHSA 的公告不收（见 osvToRecords）。 */
function ambiguousPysec(osv: OsvRecord): boolean {
  const cves = new Set([osv.id, ...(osv.aliases ?? [])].filter((i) => /^CVE-/i.test(i)));
  return cves.size > 1 && !/^GHSA-/i.test(osv.id);
}

function convertOsvPypi(zipFile: string) {
  const files = unzipSync(new Uint8Array(readFileSync(zipFile)), {
    filter: (f) => /^(GHSA|PYSEC)-[^/]+\.json$/.test(f.name),
  });
  const counts = {
    advisories: 0,
    withdrawn: 0,
    matched: 0,
    converted: 0,
    skippedNoId: 0,
    skippedAmbiguous: 0,
    skippedRange: 0,
  };
  const ghsa: AigVulnRecord[] = [];
  const pysec: AigVulnRecord[] = [];
  for (const name of Object.keys(files).sort()) {
    const osv = JSON.parse(Buffer.from(files[name]!).toString('utf8')) as OsvRecord;
    counts.advisories += 1;
    if (osv.withdrawn) {
      counts.withdrawn += 1;
      continue;
    }
    const hit = (osv.affected ?? []).some(
      (a) => a.package?.ecosystem === 'PyPI' && acceptPypi(a.package.name ?? ''),
    );
    if (!hit) continue;
    counts.matched += 1;
    if (!advisoryIdOf([osv.id, ...(osv.aliases ?? [])]).id) {
      counts.skippedNoId += 1;
      continue;
    }
    const recs = osvToRecords(osv, { ecosystem: 'pypi', accept: acceptPypi, source: 'osv-pypi' });
    if (!recs.length) counts[ambiguousPysec(osv) ? 'skippedAmbiguous' : 'skippedRange'] += 1;
    counts.converted += recs.length;
    (osv.id.startsWith('GHSA-') ? ghsa : pysec).push(...recs);
  }
  return { ghsa, pysec, counts };
}

function convertOsvNpm(caches: NpmCache[]) {
  const counts = {
    advisories: 0,
    withdrawn: 0,
    matched: 0,
    converted: 0,
    skippedNoId: 0,
    skippedAmbiguous: 0,
    skippedRange: 0,
  };
  const byId = new Map<string, OsvRecord>();
  for (const c of caches) for (const v of c.vulns) byId.set(v.id, v);
  const records: AigVulnRecord[] = [];
  for (const id of [...byId.keys()].sort()) {
    const osv = byId.get(id)!;
    counts.advisories += 1;
    if (osv.withdrawn) {
      counts.withdrawn += 1;
      continue;
    }
    counts.matched += 1;
    if (!advisoryIdOf([osv.id, ...(osv.aliases ?? [])]).id) {
      counts.skippedNoId += 1;
      continue;
    }
    const recs = osvToRecords(osv, { ecosystem: 'npm', accept: acceptNpm, source: 'osv-npm' });
    if (!recs.length) counts[ambiguousPysec(osv) ? 'skippedAmbiguous' : 'skippedRange'] += 1;
    counts.converted += recs.length;
    records.push(...recs);
  }
  return { records, counts };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const aigInfo = await fetchAig();
const zipInfo = await fetchPypiZip();
const npmCaches = await fetchNpm();

const aig = convertAig(aigInfo.commit);
const pypi = convertOsvPypi(path.join(osvDir, 'PyPI-all.zip'));
const npm = convertOsvNpm(npmCaches);

// 优先级：AIG > OSV GHSA（PyPI、npm）> OSV PYSEC
// 只给 packages.ts 里没有映射的 AIG 目录补包名；有映射但条目被判为“不属于该包”的，不因 OSV 改判，
// 带包名的 OSV 条目单独保留（mergeRecords 的 keptUnfilled）。
const merged = mergeRecords([aig.records, [...pypi.ghsa, ...npm.records], pypi.pysec], {
  canFillPackage: (r) => r.source === 'aig' && !mappingForDir(r.component),
});
const records = merged.records.filter((r) => parseRule(r.rule).kind === 'version');
if (records.length !== merged.records.length) throw new Error('合并后出现无法解析的规则');

const count = (key: string) => records.filter((r) => r.source === key).length;
const npmFetchedAt =
  npmCaches
    .map((c) => c.fetchedAt)
    .sort()
    .at(-1) ?? '';
const sources: VulnSourceMeta[] = [
  {
    key: 'aig',
    name: 'Tencent Zhuque Lab AI-Infra-Guard 漏洞库（data/vuln，中文版）',
    repository: 'https://github.com/Tencent/AI-Infra-Guard',
    license: 'Apache-2.0',
    notice: AIG_NOTICE,
    version: aigInfo.commit,
    fetchedAt: aigInfo.fetchedAt,
    records: count('aig'),
    counts: aig.counts,
  },
  {
    key: 'osv-pypi',
    name: 'OSV PyPI 公告（GitHub Advisory Database 与 PyPI Advisory Database）',
    repository: zipInfo.url,
    license: 'CC-BY-4.0',
    notice: OSV_NOTICE,
    version: `Last-Modified ${zipInfo.lastModified}; sha256 ${zipInfo.sha256}`,
    fetchedAt: zipInfo.fetchedAt,
    records: count('osv-pypi'),
    counts: pypi.counts,
  },
  {
    key: 'osv-npm',
    name: 'OSV npm 公告（GitHub Advisory Database）',
    repository: OSV_QUERY_URL,
    license: 'CC-BY-4.0',
    notice: OSV_NOTICE,
    version: `osv.dev /v1/query @ ${npmFetchedAt}; ${OSV_NPM_PACKAGES.length} 个包`,
    fetchedAt: npmFetchedAt,
    records: count('osv-npm'),
    counts: npm.counts,
  },
];

const packageCounts = new Map<string, number>();
for (const r of records) {
  if (!r.package) continue;
  const key = `${r.package.ecosystem}:${r.package.name}`;
  packageCounts.set(key, (packageCounts.get(key) ?? 0) + 1);
}

const data: AigVulnDataFile = {
  meta: {
    generatedAt: new Date().toISOString(),
    importScript: 'apps/api/scripts/update-aig-vulns.ts',
    dedupe: DEDUPE_RULE,
    sources,
    counts: {
      total: records.length,
      withPackage: records.filter((r) => r.package).length,
      duplicatesRemoved: merged.duplicates,
      packageFilledFromOsv: merged.packageFilled,
      keptUnfilled: merged.keptUnfilled,
      rulesFromOsv: merged.rulesFromOsv,
      ruleConflicts: merged.ruleConflicts,
    },
    packages: [...packageCounts.entries()]
      .map(([key, n]) => {
        const i = key.indexOf(':');
        return { ecosystem: key.slice(0, i), name: key.slice(i + 1), records: n };
      })
      .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name)),
  },
  records,
};

// meta 缩进，records 每条一行，便于看差异
const recordLines = data.records.map((r) => JSON.stringify(r)).join(',\n');
const metaText = JSON.stringify(data.meta, null, 2).replace(/\n/g, '\n  ');
writeFileSync(outFile, `{\n  "meta": ${metaText},\n  "records": [\n${recordLines}\n  ]\n}\n`);
console.log(
  JSON.stringify(
    {
      outFile,
      total: records.length,
      bySource: Object.fromEntries(sources.map((s) => [s.key, s.records])),
      counts: data.meta.counts,
      sourceCounts: Object.fromEntries(sources.map((s) => [s.key, s.counts])),
      npmPackagesWithData: npmCaches
        .filter((c) => c.vulns.length)
        .map((c) => `${c.package}:${c.vulns.length}`),
      unusedRawFiles: readdirSync(npmDir).length - OSV_NPM_PACKAGES.length,
    },
    null,
    2,
  ),
);
