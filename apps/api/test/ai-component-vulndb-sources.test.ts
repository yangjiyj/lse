import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VULNDB_FILE, loadVulnDb } from '../src/modules/engines/ai-asset/vulndb/index.js';
import {
  evaluateRuleText,
  parseRule,
} from '../src/modules/engines/ai-asset/vulndb/version-expr.js';
import {
  advisoryIdOf,
  componentKey,
  mergeRecords,
  osvRule,
  osvToRecords,
  rulesDisagree,
  type OsvRecord,
} from '../src/modules/engines/ai-asset/vulndb/sources.js';
import type { AigVulnRecord } from '../src/modules/engines/ai-asset/vulndb/types.js';

const ID_RE = /^(CVE-\d{4}-\d{4,}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$/;

test('编号：CVE 优先，其次 GHSA；其他编号不算', () => {
  assert.deepEqual(advisoryIdOf(['PYSEC-2023-1', 'GHSA-ABCD-1234-wxyz', 'CVE-2023-29374']), {
    id: 'CVE-2023-29374',
    cve: 'CVE-2023-29374',
    ghsa: 'GHSA-abcd-1234-wxyz',
  });
  assert.deepEqual(advisoryIdOf(['GHSA-abcd-1234-wxyz']), {
    id: 'GHSA-abcd-1234-wxyz',
    cve: null,
    ghsa: 'GHSA-abcd-1234-wxyz',
  });
  assert.equal(advisoryIdOf(['PYSEC-2023-1', 'SUPPLY-CHAIN-2025-LITELLM']).id, null);
});

test('OSV 受影响范围转成版本规则', () => {
  assert.equal(
    osvRule({ ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.2.3' }] }] }),
    'version < "1.2.3"',
  );
  assert.equal(
    osvRule({
      ranges: [
        {
          type: 'ECOSYSTEM',
          events: [
            { introduced: '1.0' },
            { fixed: '1.5' },
            { introduced: '2.0' },
            { last_affected: '2.1' },
          ],
        },
      ],
    }),
    '(version >= "1.0" && version < "1.5") || (version >= "2.0" && version <= "2.1")',
  );
  assert.equal(
    osvRule({ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }),
    'version >= "0"',
  );
  assert.equal(osvRule({ ranges: [{ type: 'GIT', events: [{ introduced: 'abc' }] }] }), null);
  assert.equal(
    osvRule({ versions: ['0.1.0', '0.1.1'] }),
    'version == "0.1.0" || version == "0.1.1"',
  );
  assert.equal(
    osvRule({
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: 'main-branch' }] }],
    }),
    null,
    '版本号无法解析时不收',
  );
  for (const r of ['version < "1.2.3"', 'version >= "0"'])
    assert.equal(parseRule(r).kind, 'version');
});

const osv = (over: Partial<OsvRecord>): OsvRecord => ({
  id: 'GHSA-aaaa-bbbb-cccc',
  aliases: ['CVE-2024-0001'],
  summary: 'Path traversal in demo',
  details: 'details',
  database_specific: { severity: 'MODERATE' },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }],
  affected: [
    {
      package: { ecosystem: 'PyPI', name: 'LangChain_Core' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '0.1.30' }] }],
    },
    {
      package: { ecosystem: 'PyPI', name: 'not-ai' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.0' }] }],
    },
  ],
  references: [
    { type: 'WEB', url: 'https://github.com/x/y/security/advisories/GHSA-aaaa-bbbb-cccc' },
  ],
  ...over,
});

test('OSV 条目转换：只收选定的 AI 组件，带编号、范围、来源', () => {
  const out = osvToRecords(osv({}), {
    ecosystem: 'pypi',
    accept: (name) => name === 'langchain-core',
    source: 'osv-pypi',
  });
  assert.equal(out.length, 1);
  const r = out[0]!;
  assert.equal(r.id, 'CVE-2024-0001');
  assert.equal(r.cve, 'CVE-2024-0001');
  assert.deepEqual(r.package, { ecosystem: 'pypi', name: 'langchain-core' });
  assert.equal(r.component, 'langchain-core');
  assert.equal(r.rule, 'version < "0.1.30"');
  assert.equal(r.severity, 'MEDIUM');
  assert.equal(r.source, 'osv-pypi');
  assert.match(r.remediation, /0\.1\.30/);
  assert.deepEqual(r.advisoryIds, ['GHSA-aaaa-bbbb-cccc', 'CVE-2024-0001']);
  assert.equal(r.ghsaSeverity, 'MEDIUM', 'GHSA 公告的等级另存一份');
  assert.ok(r.references[0]!.startsWith('https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc'));
  const [pysec] = osvToRecords(osv({ id: 'PYSEC-2024-9' }), {
    ecosystem: 'pypi',
    accept: (name) => name === 'langchain-core',
    source: 'osv-pypi',
  });
  assert.equal(pysec!.ghsaSeverity, undefined, 'PYSEC 公告的等级不算 GHSA 等级');
  assert.deepEqual(
    osvToRecords(osv({ withdrawn: '2024-01-01T00:00:00Z' }), {
      ecosystem: 'pypi',
      accept: () => true,
      source: 'osv-pypi',
    }),
    [],
  );
  assert.deepEqual(
    osvToRecords(osv({ id: 'PYSEC-2024-9', aliases: [] }), {
      ecosystem: 'pypi',
      accept: () => true,
      source: 'osv-pypi',
    }),
    [],
    '没有 CVE/GHSA 编号的不收',
  );
});

const rec = (over: Partial<AigVulnRecord>): AigVulnRecord => ({
  id: 'CVE-2024-0001',
  cve: 'CVE-2024-0001',
  component: 'vllm',
  componentName: 'vllm',
  aliases: [],
  package: { ecosystem: 'pypi', name: 'vllm' },
  title: 't',
  details: '',
  severity: 'HIGH',
  cvss: null,
  rule: 'version < "1.0"',
  remediation: '',
  references: [],
  sourcePath: 'data/vuln/vllm/CVE-2024-0001.yaml',
  source: 'aig',
  advisoryIds: ['CVE-2024-0001'],
  ...over,
});

test('去重：同组件任一编号相同即为同一条，AIG 优先，其次 GHSA，并合并编号', () => {
  const aig = [
    rec({}),
    rec({
      id: 'CVE-2024-0002',
      cve: 'CVE-2024-0002',
      component: 'jupyter-server',
      package: null,
      advisoryIds: ['CVE-2024-0002'],
    }),
    rec({ component: 'open-webui', package: { ecosystem: 'pypi', name: 'open-webui' } }),
    rec({ component: 'openwebui', package: { ecosystem: 'pypi', name: 'open-webui' } }),
  ];
  const ghsa = [
    rec({
      id: 'CVE-2024-0001',
      source: 'osv-pypi',
      advisoryIds: ['GHSA-aaaa-bbbb-cccc', 'CVE-2024-0001'],
    }),
    rec({
      id: 'CVE-2024-0002',
      cve: 'CVE-2024-0002',
      component: 'jupyter-server',
      package: { ecosystem: 'pypi', name: 'jupyter-server' },
      source: 'osv-pypi',
      advisoryIds: ['GHSA-dddd-eeee-ffff', 'CVE-2024-0002'],
    }),
    rec({
      id: 'GHSA-1111-2222-3333',
      cve: null,
      component: 'langchain',
      package: { ecosystem: 'pypi', name: 'langchain' },
      source: 'osv-pypi',
      advisoryIds: ['GHSA-1111-2222-3333'],
    }),
  ];
  const pysec = [
    rec({
      id: 'CVE-2024-0009',
      cve: 'CVE-2024-0009',
      component: 'langchain',
      package: { ecosystem: 'pypi', name: 'langchain' },
      source: 'osv-pypi',
      advisoryIds: ['PYSEC-2024-1', 'GHSA-1111-2222-3333', 'CVE-2024-0009'],
    }),
  ];
  const { records, duplicates } = mergeRecords([aig, ghsa, pysec]);
  assert.equal(duplicates, 4);
  assert.equal(records.length, 4);
  const jupyter = records.find((r) => r.id === 'CVE-2024-0002')!;
  assert.equal(jupyter.source, 'aig');
  assert.deepEqual(
    jupyter.package,
    { ecosystem: 'pypi', name: 'jupyter-server' },
    '用 OSV 同编号同名包补映射',
  );
  const vllm = records.find((r) => componentKey(r) === 'pypi:vllm')!;
  assert.equal(vllm.source, 'aig');
  assert.deepEqual(vllm.advisoryIds, ['CVE-2024-0001', 'GHSA-aaaa-bbbb-cccc']);
  const lc = records.find((r) => componentKey(r) === 'pypi:langchain')!;
  assert.equal(lc.id, 'GHSA-1111-2222-3333');
  assert.deepEqual(lc.advisoryIds, ['GHSA-1111-2222-3333', 'PYSEC-2024-1', 'CVE-2024-0009']);
});

test('组件口径：有包名用「生态:包名」，没有包名用目录名并按别名表归一', () => {
  assert.equal(
    componentKey({
      component: 'langchain',
      package: { ecosystem: 'pypi', name: 'LangChain_Core' },
    }),
    'pypi:langchain-core',
  );
  assert.equal(
    componentKey({ component: 'langsmith', package: { ecosystem: 'npm', name: 'langsmith' } }),
    'npm:langsmith',
  );
  assert.equal(componentKey({ component: 'Chuanhugpt', package: null }), 'chuanhuchatgpt');
  assert.equal(
    componentKey({ component: 'mcp-inspector', package: null }),
    '@modelcontextprotocol/inspector',
  );
});

test('去重：PyPI 与 npm 的同名包是两个组件，同一公告各留一条', () => {
  const ids = ['GHSA-3644-q5cj-c5c7', 'CVE-2026-45134'];
  const osvRecs = [
    rec({
      id: 'CVE-2026-45134',
      cve: 'CVE-2026-45134',
      component: 'langsmith',
      package: { ecosystem: 'pypi', name: 'langsmith' },
      rule: 'version < "0.8.0"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/GHSA-3644-q5cj-c5c7',
      advisoryIds: ids,
    }),
    rec({
      id: 'CVE-2026-45134',
      cve: 'CVE-2026-45134',
      component: 'langsmith',
      package: { ecosystem: 'npm', name: 'langsmith' },
      rule: 'version < "0.6.0"',
      source: 'osv-npm',
      sourcePath: 'osv:npm/GHSA-3644-q5cj-c5c7',
      advisoryIds: ids,
    }),
  ];
  const { records, duplicates } = mergeRecords([[], osvRecs]);
  assert.equal(duplicates, 0);
  assert.deepEqual(
    records.map((r) => componentKey(r)),
    ['pypi:langsmith', 'npm:langsmith'],
  );
});

test('去重：保留条目没有包名、又不允许补包名时，带包名的重复条目单独保留', () => {
  const aig = [
    rec({
      id: 'CVE-2024-0100',
      cve: 'CVE-2024-0100',
      component: 'Chuanhugpt',
      package: null,
      rule: 'version == "20240410"',
      advisoryIds: ['CVE-2024-0100'],
    }),
    rec({
      id: 'CVE-2024-7774',
      cve: 'CVE-2024-7774',
      component: 'langchain',
      package: null,
      title: 'LangChain.js 路径遍历',
      sourcePath: 'data/vuln/langchain/CVE-2024-7774.yaml',
      advisoryIds: ['CVE-2024-7774'],
    }),
  ];
  const ghsa = [
    rec({
      id: 'CVE-2024-0100',
      cve: 'CVE-2024-0100',
      component: 'chuanhuchatgpt',
      package: { ecosystem: 'pypi', name: 'chuanhuchatgpt' },
      rule: 'version <= "20240410"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/GHSA-aaaa-0000-0001',
      advisoryIds: ['GHSA-aaaa-0000-0001', 'CVE-2024-0100'],
    }),
    rec({
      id: 'CVE-2024-7774',
      cve: 'CVE-2024-7774',
      component: 'langchain',
      package: { ecosystem: 'npm', name: 'langchain' },
      rule: 'version < "0.2.19"',
      source: 'osv-npm',
      sourcePath: 'osv:npm/GHSA-hc5w-c9f8-9cc4',
      advisoryIds: ['GHSA-hc5w-c9f8-9cc4', 'CVE-2024-7774'],
    }),
    rec({
      id: 'CVE-2024-4253',
      cve: 'CVE-2024-4253',
      component: 'gradio',
      package: { ecosystem: 'pypi', name: 'gradio' },
      rule: 'version < "4.29.0"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/GHSA-gggg-0000-0001',
      advisoryIds: ['GHSA-gggg-0000-0001', 'CVE-2024-4253'],
    }),
  ];
  const pysec = [
    rec({
      id: 'CVE-2024-4253',
      cve: 'CVE-2024-4253',
      component: 'gradio',
      package: { ecosystem: 'pypi', name: 'gradio' },
      rule: 'version < "4.29.0"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/PYSEC-2024-321',
      advisoryIds: ['PYSEC-2024-321', 'CVE-2024-4253'],
    }),
  ];
  aig.push(
    rec({
      id: 'CVE-2024-4253',
      cve: 'CVE-2024-4253',
      component: 'gradio',
      package: null,
      sourcePath: 'data/vuln/gradio/CVE-2024-4253.yaml',
      advisoryIds: ['CVE-2024-4253'],
    }),
  );
  const { records, duplicates, packageFilled, keptUnfilled } = mergeRecords([aig, ghsa, pysec], {
    canFillPackage: (r) => r.component === 'Chuanhugpt',
  });
  assert.equal(packageFilled, 1);
  assert.equal(keptUnfilled, 2, 'npm langchain、PyPI gradio 两条单独保留');
  assert.equal(duplicates, 2, 'Chuanhugpt 补包名并掉 1 条，gradio 的 PYSEC 并入单独保留的 GHSA');
  assert.equal(records.length, 5);
  const chuanhu = records.find((r) => r.id === 'CVE-2024-0100')!;
  assert.deepEqual(chuanhu.package, { ecosystem: 'pypi', name: 'chuanhuchatgpt' });
  assert.equal(chuanhu.rule, 'version <= "20240410"', '补上包名后同包同编号，范围以 OSV 为准');
  const [aigLc, npmLc] = records.filter((r) => r.id === 'CVE-2024-7774');
  assert.equal(aigLc!.source, 'aig');
  assert.equal(aigLc!.package, null, 'AIG 判为不属于该包的，不因 OSV 改判');
  assert.deepEqual(aigLc!.advisoryIds, ['CVE-2024-7774']);
  assert.equal(npmLc!.source, 'osv-npm');
  assert.deepEqual(npmLc!.package, { ecosystem: 'npm', name: 'langchain' });
  const [aigGr, osvGr] = records.filter((r) => r.id === 'CVE-2024-4253');
  assert.equal(aigGr!.package, null);
  assert.deepEqual(osvGr!.package, { ecosystem: 'pypi', name: 'gradio' });
  assert.deepEqual(osvGr!.advisoryIds, ['GHSA-gggg-0000-0001', 'CVE-2024-4253', 'PYSEC-2024-321']);
});

test('版本规则比对：只看各版本上的判定，写法不同但判定相同不算冲突', () => {
  assert.equal(rulesDisagree('version >= "0" && version < "0.2.19"', 'version < "0.2.19"'), false);
  assert.equal(
    rulesDisagree('version > "0" && version < "1.15.4"', 'version < "1.15.4"'),
    false,
    '版本 0 不算',
  );
  assert.equal(rulesDisagree('version <= "2.20.0"', 'version < "2.21.0"'), true);
  assert.equal(
    rulesDisagree(
      'version < "1.0.7" || version < "0.3.80"',
      '(version >= "1.0.0" && version < "1.0.7") || (version < "0.3.80")',
    ),
    true,
  );
  assert.equal(
    rulesDisagree(
      'version < "1.123.76"',
      '(version < "1.123.76") || (version >= "2.0.0" && version < "2.37.7")',
    ),
    true,
  );
});

test('同包同编号：版本范围以 OSV 为准，标题、详情、修复建议、严重度仍用 AIG；记录冲突组数与 GHSA 等级', () => {
  const aig = [
    rec({
      id: 'CVE-2026-86080',
      cve: 'CVE-2026-86080',
      component: 'n8n',
      package: { ecosystem: 'npm', name: 'n8n' },
      title: 'n8n 远程代码执行',
      details: '中文详情',
      remediation: '升级到 1.123.76',
      severity: 'HIGH',
      rule: 'version < "1.123.76"',
      sourcePath: 'data/vuln/n8n/CVE-2026-86080.yaml',
      advisoryIds: ['CVE-2026-86080'],
    }),
    rec({
      id: 'CVE-2024-6706',
      cve: 'CVE-2024-6706',
      component: 'open-webui',
      package: { ecosystem: 'pypi', name: 'open-webui' },
      rule: 'version >= "0" && version < "0.3.14"',
      advisoryIds: ['CVE-2024-6706'],
    }),
    rec({
      id: 'CVE-2025-65106',
      cve: 'CVE-2025-65106',
      component: 'langchain',
      package: { ecosystem: 'pypi', name: 'langchain-core' },
      rule: 'version < "1.0.7" || version < "0.3.80"',
      advisoryIds: ['CVE-2025-65106'],
    }),
  ];
  const n8nRule = '(version < "1.123.76") || (version >= "2.0.0" && version < "2.37.7")';
  const lcRule = '(version >= "1.0.0" && version < "1.0.7") || (version < "0.3.80")';
  const ghsa = [
    rec({
      id: 'CVE-2026-86080',
      cve: 'CVE-2026-86080',
      component: 'n8n',
      package: { ecosystem: 'npm', name: 'n8n' },
      title: 'n8n RCE',
      remediation: '升级 n8n 至 1.123.76 / 2.37.7 或更高版本（以上游公告为准）。',
      severity: 'CRITICAL',
      ghsaSeverity: 'CRITICAL',
      rule: n8nRule,
      source: 'osv-npm',
      sourcePath: 'osv:npm/GHSA-5m98-cgcr-xx3q',
      advisoryIds: ['GHSA-5m98-cgcr-xx3q', 'CVE-2026-86080'],
    }),
    rec({
      id: 'CVE-2024-6706',
      cve: 'CVE-2024-6706',
      component: 'open-webui',
      package: { ecosystem: 'pypi', name: 'open-webui' },
      severity: 'MEDIUM',
      ghsaSeverity: 'MEDIUM',
      rule: 'version < "0.3.14"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/GHSA-5jp3-wp5v-5363',
      advisoryIds: ['GHSA-5jp3-wp5v-5363', 'CVE-2024-6706'],
    }),
    rec({
      id: 'CVE-2025-65106',
      cve: 'CVE-2025-65106',
      component: 'langchain-core',
      package: { ecosystem: 'pypi', name: 'langchain-core' },
      rule: lcRule,
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/GHSA-6qv9-48xg-fc7f',
      advisoryIds: ['GHSA-6qv9-48xg-fc7f', 'CVE-2025-65106'],
    }),
  ];
  const pysec = [
    rec({
      id: 'CVE-2025-65106',
      cve: 'CVE-2025-65106',
      component: 'langchain-core',
      package: { ecosystem: 'pypi', name: 'langchain-core' },
      rule: 'version < "9.0"',
      source: 'osv-pypi',
      sourcePath: 'osv:PyPI/PYSEC-2026-1518',
      advisoryIds: ['PYSEC-2026-1518', 'CVE-2025-65106'],
    }),
  ];
  const { records, ruleConflicts, rulesFromOsv } = mergeRecords([aig, ghsa, pysec]);
  assert.equal(records.length, 3);
  assert.equal(rulesFromOsv, 3);
  assert.equal(ruleConflicts, 2, 'n8n、langchain-core 判定不同；open-webui 只是写法不同');

  const n8n = records.find((r) => r.id === 'CVE-2026-86080')!;
  assert.equal(n8n.source, 'aig');
  assert.equal(n8n.rule, n8nRule);
  assert.equal(n8n.ruleSourcePath, 'osv:npm/GHSA-5m98-cgcr-xx3q');
  assert.equal(evaluateRuleText(n8n.rule, '2.30.0'), true);
  assert.equal(n8n.title, 'n8n 远程代码执行');
  assert.equal(n8n.details, '中文详情');
  assert.equal(n8n.remediation, '升级到 1.123.76');
  assert.equal(n8n.severity, 'HIGH', '严重度取 AIG');
  assert.equal(n8n.ghsaSeverity, 'CRITICAL');

  const owu = records.find((r) => r.id === 'CVE-2024-6706')!;
  assert.equal(owu.rule, 'version < "0.3.14"');
  assert.equal(owu.ghsaSeverity, 'MEDIUM');

  const lc = records.find((r) => r.id === 'CVE-2025-65106')!;
  assert.equal(lc.rule, lcRule, '先到的 GHSA 定范围，PYSEC 不再改');
  assert.equal(lc.ruleSourcePath, 'osv:PyPI/GHSA-6qv9-48xg-fc7f');
  assert.equal(evaluateRuleText(lc.rule, '0.3.90'), false);
  assert.equal(lc.ghsaSeverity, undefined, '该 GHSA 没有等级');
});

test('同包同编号：一条 OSV 公告对上同包的多条 AIG 条目（AIG 同一漏洞分 CVE、GHSA 两个文件）时，每条都用 OSV 范围', () => {
  const pkg = { ecosystem: 'npm' as const, name: 'openclaw' };
  const aig = [
    rec({
      id: 'CVE-2026-4040',
      cve: 'CVE-2026-4040',
      component: 'openclaw',
      package: pkg,
      rule: 'version <= "2026.2.17"',
      sourcePath: 'data/vuln/openclaw/CVE-2026-4040.yaml',
      advisoryIds: ['CVE-2026-4040'],
    }),
    rec({
      id: 'GHSA-6c9j-x93c-rw6j',
      cve: null,
      component: 'openclaw',
      package: pkg,
      rule: 'version <= "2026.2.17"',
      sourcePath: 'data/vuln/openclaw/GHSA-6c9j-x93c-rw6j.yaml',
      advisoryIds: ['GHSA-6c9j-x93c-rw6j'],
    }),
  ];
  const ghsa = [
    rec({
      id: 'CVE-2026-4040',
      cve: 'CVE-2026-4040',
      component: 'openclaw',
      package: pkg,
      rule: 'version < "2026.2.19"',
      ghsaSeverity: 'MEDIUM',
      source: 'osv-npm',
      sourcePath: 'osv:npm/GHSA-6c9j-x93c-rw6j',
      advisoryIds: ['GHSA-6c9j-x93c-rw6j', 'CVE-2026-4040'],
    }),
  ];
  const { records, duplicates, rulesFromOsv, ruleConflicts } = mergeRecords([aig, ghsa]);
  assert.equal(records.length, 2);
  assert.equal(duplicates, 1);
  assert.equal(rulesFromOsv, 2);
  assert.equal(ruleConflicts, 2);
  for (const r of records) {
    assert.equal(r.rule, 'version < "2026.2.19"', r.sourcePath);
    assert.equal(r.ruleSourcePath, 'osv:npm/GHSA-6c9j-x93c-rw6j');
    assert.equal(r.ghsaSeverity, 'MEDIUM');
  }
  assert.deepEqual(
    records.map((r) => r.advisoryIds),
    [['CVE-2026-4040'], ['GHSA-6c9j-x93c-rw6j']],
    '编号仍各归各的',
  );
});

test('OSV 公告的别名里有多个 CVE 时视为不确定：只用于判重，不并编号', () => {
  const cluster = osv({
    id: 'GHSA-365w-hqf6-vxfg',
    aliases: ['CVE-2026-56260', 'CVE-2026-56261', 'GHSA-53rg-46cm-4g2v'],
  });
  const opts = {
    ecosystem: 'pypi' as const,
    accept: (n: string) => n === 'langchain-core',
    source: 'osv-pypi' as const,
  };
  const [r] = osvToRecords(cluster, opts);
  assert.equal(r!.id, 'GHSA-365w-hqf6-vxfg');
  assert.equal(r!.cve, null);
  assert.deepEqual(r!.advisoryIds, ['GHSA-365w-hqf6-vxfg']);
  assert.deepEqual(
    osvToRecords(
      osv({ id: 'PYSEC-2026-229', aliases: ['CVE-2026-56260', 'CVE-2026-56261'] }),
      opts,
    ),
    [],
  );

  const a = rec({
    id: 'CVE-2026-56260',
    cve: 'CVE-2026-56260',
    component: 'langchain-core',
    package: { ecosystem: 'pypi', name: 'langchain-core' },
    advisoryIds: ['CVE-2026-56260'],
  });
  const b = rec({
    id: 'CVE-2026-56261',
    cve: 'CVE-2026-56261',
    component: 'langchain-core',
    package: { ecosystem: 'pypi', name: 'langchain-core' },
    advisoryIds: ['CVE-2026-56261'],
  });
  const merged = mergeRecords([[a, b], osvToRecords(cluster, opts)]);
  assert.equal(merged.records.length, 2);
  assert.equal(merged.duplicates, 1);
  assert.deepEqual(
    merged.records.map((x) => x.advisoryIds),
    [['CVE-2026-56260'], ['CVE-2026-56261']],
  );
  assert.ok(merged.records.every((x) => !('relatedIds' in x)));
  assert.deepEqual(
    merged.records.map((x) => x.rule),
    [a.rule, b.rule],
    '不确定的公告不改版本范围',
  );
  assert.equal(merged.ruleConflicts, 0);
});

test('漏洞库数据：不少于 2000 条，每条有编号、组件、受影响范围和来源', () => {
  const { data } = loadVulnDb();
  assert.ok(data.records.length >= 2000, `当前 ${data.records.length} 条`);
  const sources = new Set(data.meta.sources.map((s) => s.key));
  for (const r of data.records) {
    assert.match(r.id, ID_RE, r.sourcePath);
    assert.ok(r.component.trim(), r.id);
    assert.equal(parseRule(r.rule).kind, 'version', `${r.id} ${r.rule}`);
    assert.ok(sources.has(r.source), `${r.id} 来源 ${r.source}`);
    assert.ok(r.advisoryIds.includes(r.id), r.id);
  }
});

test('漏洞库数据：按编号加组件没有重复', () => {
  const { data } = loadVulnDb();
  const seen = new Map<string, string>();
  for (const r of data.records) {
    for (const id of r.advisoryIds) {
      const key = `${id}|${componentKey(r)}`;
      assert.ok(!seen.has(key), `重复：${key}（${seen.get(key)} 与 ${r.sourcePath}）`);
      seen.set(key, r.sourcePath);
    }
  }
});

test('漏洞库数据：meta 写明每个来源、许可证、拉取日期、上游版本，条数对得上', () => {
  const { data } = loadVulnDb();
  const { meta } = data;
  assert.ok(meta.sources.length >= 2);
  for (const s of meta.sources) {
    assert.ok(s.name && s.repository && s.license && s.version, s.key);
    assert.ok(!Number.isNaN(Date.parse(s.fetchedAt)), `${s.key} fetchedAt`);
    assert.equal(s.records, data.records.filter((r) => r.source === s.key).length, s.key);
  }
  const aig = meta.sources.find((s) => s.key === 'aig')!;
  assert.equal(aig.license, 'Apache-2.0');
  assert.match(aig.version, /^[0-9a-f]{40}$/);
  assert.match(aig.notice, /Tencent Zhuque Lab AI-Infra-Guard/);
  for (const s of meta.sources.filter((x) => x.key !== 'aig')) assert.equal(s.license, 'CC-BY-4.0');
  assert.equal(meta.counts.total, data.records.length);
  assert.ok(meta.dedupe.includes('编号'));
  assert.ok(meta.counts.ruleConflicts > 0, 'OSV 与 AIG 判定不同的组数');
  assert.ok(meta.counts.rulesFromOsv >= meta.counts.ruleConflicts);
  assert.equal(
    data.records.filter((r) => r.source === 'aig' && r.ruleSourcePath).length,
    meta.counts.rulesFromOsv,
  );
  assert.ok(meta.counts.keptUnfilled > 0);
});

test('漏洞库数据：每条记录占一行，逐行可解析，顺序与 records 一致', () => {
  const { data } = loadVulnDb();
  const lines = readFileSync(VULNDB_FILE, 'utf8').split('\n');
  const recordLines = lines.filter((l) => l.startsWith('{"id":'));
  assert.equal(recordLines.length, data.records.length);
  recordLines.forEach((line, i) => {
    const r = JSON.parse(line.replace(/,$/, '')) as AigVulnRecord;
    assert.equal(r.sourcePath, data.records[i]!.sourcePath);
  });
});

test('漏洞库数据：与 GHSA 重叠的 AIG 条目另存 GHSA 等级，严重度仍取 AIG', () => {
  const { data } = loadVulnDb();
  const levels = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  const aigWithGhsa = data.records.filter((r) => r.source === 'aig' && r.ghsaSeverity);
  assert.ok(aigWithGhsa.length > 0);
  for (const r of data.records)
    if (r.ghsaSeverity !== undefined) assert.ok(levels.has(r.ghsaSeverity), r.id);
  assert.ok(
    aigWithGhsa.some((r) => r.severity !== r.ghsaSeverity),
    '存在等级不同的条目时，severity 保留 AIG 的',
  );
});
