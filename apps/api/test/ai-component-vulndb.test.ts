import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVulnDb,
  matchDependencyVulns,
  rangeLowerBound,
} from '../src/modules/engines/ai-asset/vulndb/index.js';
import { parseManifest } from '../src/modules/engines/ai-asset/vulndb/manifests.js';

const find = (matches: ReturnType<typeof matchDependencyVulns>, name: string) =>
  matches.find((m) => m.packageName === name);

test('漏洞库数据：meta 记录 AIG 来源、commit、条数与跳过数', () => {
  const { data } = loadVulnDb();
  const aig = data.meta.sources.find((s) => s.key === 'aig')!;
  assert.equal(aig.license, 'Apache-2.0');
  assert.match(aig.version, /^[0-9a-f]{40}$/);
  assert.equal(aig.counts.files, 2738);
  assert.equal(aig.counts.skippedEmptyRule, 87);
  assert.equal(aig.counts.skippedNonVersionRule, 7);
  assert.equal(aig.counts.skippedNoId, 1);
  assert.equal(
    aig.counts.converted,
    data.records.filter((r) => r.source === 'aig').length + 1,
    '多出的 1 条是 AIG 内部重复：openwebui 与 open-webui 两个目录都有 CVE-2025-46719',
  );
  assert.equal(data.meta.counts.total, data.records.length);
  assert.ok(data.records.every((r) => r.rule && !r.rule.includes('is_internal')));
});

test('正例：langchain==0.0.131 命中 CVE-2023-29374（数据规则 version <= "0.0.131"），确定命中', () => {
  const matches = matchDependencyVulns([
    { path: 'app/requirements.txt', content: '# ai deps\nlangchain==0.0.131\nrequests==2.31.0\n' },
  ]);
  const hit = find(matches, 'langchain');
  assert.ok(hit);
  assert.equal(hit.certainty, 'CONFIRMED');
  assert.equal(hit.file, 'app/requirements.txt');
  assert.equal(hit.line, 2);
  assert.ok(hit.cves.includes('CVE-2023-29374'));
  assert.equal(hit.highestSeverity, 'CRITICAL');
  assert.ok(hit.cves.length > 1, '同一包多条 CVE 合并为一条匹配');
  assert.equal(matches.filter((m) => m.packageName === 'langchain').length, 1);
  assert.match(hit.source, /^AI-Infra-Guard 漏洞库（Apache-2\.0）@[0-9a-f]{12}(；|$)/);
  const aigAdvisory = hit.advisories.find((a) => a.id === 'CVE-2023-29374');
  assert.match(aigAdvisory!.source, /^AI-Infra-Guard 漏洞库/);
  assert.ok(hit.title && hit.remediation);
  assert.equal(find(matches, 'requests'), undefined, '未收录的包不报');
});

test('正例：vllm==0.8.4 命中 CVE-2025-48942（>=0.8.0 <0.9.0）；gradio==4.44.0 命中 CVE-2024-47164（<5.0.0）', () => {
  const matches = matchDependencyVulns([
    { path: 'pyproject.toml', content: '[project]\nname = "x"\ndependencies = [\n  "vllm==0.8.4",\n  "gradio[oauth]==4.44.0 ; python_version>=\'3.10\'",\n]\n' },
  ]);
  const vllm = find(matches, 'vllm');
  assert.ok(vllm?.cves.includes('CVE-2025-48942'));
  assert.equal(vllm?.line, 4);
  assert.ok(!vllm?.cves.includes('CVE-2025-65015'), 'joserfc 条目归属 joserfc，不算 vllm');
  const gradio = find(matches, 'gradio');
  assert.ok(gradio?.cves.includes('CVE-2024-47164'));
  assert.equal(gradio?.line, 5);
  assert.equal(gradio?.certainty, 'CONFIRMED');
});

test('负例：已修复的新版本、未收录的包不报', () => {
  const matches = matchDependencyVulns([
    { path: 'requirements.txt', content: 'vllm==0.32.0\ngradio==6.20.0\nnumpy==1.26.4\nmy-private-pkg==0.0.1\n' },
  ]);
  assert.deepEqual(matches, []);
});

test('范围版本：下界落在受影响区间报 POSSIBLE；无下界的范围不报', () => {
  const matches = matchDependencyVulns([
    { path: 'requirements-dev.txt', content: 'langchain>=0.0.100,<0.1\nvllm\ngradio<4\n' },
  ]);
  const lc = find(matches, 'langchain');
  assert.equal(lc?.certainty, 'POSSIBLE');
  assert.equal(lc?.version, '>=0.0.100,<0.1');
  assert.equal(find(matches, 'vllm'), undefined);
  assert.equal(find(matches, 'gradio'), undefined);
  assert.equal(rangeLowerBound('^1.2.3'), '1.2.3');
  assert.equal(rangeLowerBound('~=0.2'), '0.2');
  assert.equal(rangeLowerBound('*'), null);
  assert.equal(rangeLowerBound('>1.0'), null);
});

test('npm 生态：package.json 范围降级、package-lock 与 pnpm-lock 精确命中', () => {
  const pkg = '{\n  "dependencies": {\n    "n8n": "^1.0.0",\n    "flowise": "2.1.3"\n  }\n}\n';
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/openclaw': { version: '2026.2.1' } } }, null, 2);
  const pnpm = "lockfileVersion: '9.0'\n\npackages:\n\n  n8n@1.0.0:\n    resolution: {integrity: sha512-x}\n\n  /flowise@3.1.3(react@18.0.0):\n    resolution: {}\n";
  const matches = matchDependencyVulns([
    { path: 'package.json', content: pkg },
    { path: 'package-lock.json', content: lock },
    { path: 'web/pnpm-lock.yaml', content: pnpm },
  ]);
  const n8nRange = matches.find((m) => m.packageName === 'n8n' && m.file === 'package.json');
  assert.equal(n8nRange?.certainty, 'POSSIBLE');
  assert.equal(n8nRange?.line, 3);
  const flowise = matches.find((m) => m.packageName === 'flowise' && m.file === 'package.json');
  assert.equal(flowise?.certainty, 'CONFIRMED');
  assert.ok(flowise?.cves.includes('CVE-2024-58351'), 'Flowise < 2.1.4 RCE');
  const claw = matches.find((m) => m.packageName === 'openclaw');
  assert.equal(claw?.certainty, 'CONFIRMED');
  assert.equal(claw?.file, 'package-lock.json');
  const n8nLock = matches.find((m) => m.packageName === 'n8n' && m.file === 'web/pnpm-lock.yaml');
  assert.equal(n8nLock?.certainty, 'CONFIRMED');
  assert.equal(n8nLock?.line, 5);
});

const cvesOf = (path: string, content: string) =>
  matchDependencyVulns([{ path, content }]).flatMap((m) => m.cves);

test('去重不再丢记录：npm 同名包、AIG 判为不属于该包的公告都能命中', () => {
  const langsmith = cvesOf('package.json', '{"dependencies":{"langsmith":"0.5.0"}}');
  for (const cve of ['CVE-2026-45134', 'CVE-2026-41182']) assert.ok(langsmith.includes(cve), cve);
  assert.ok(cvesOf('package.json', '{"dependencies":{"langsmith":"0.4.0"}}').includes('CVE-2026-25528'));
  const lc020 = cvesOf('package.json', '{"dependencies":{"langchain":"0.2.0"}}');
  assert.ok(lc020.includes('CVE-2024-7774'));
  assert.ok(cvesOf('package.json', '{"dependencies":{"langchain":"0.3.0"}}').includes('CVE-2025-68665'));
  assert.ok(cvesOf('requirements.txt', 'gradio==4.28.0\n').includes('CVE-2024-4253'));
});

test('同包同编号以 OSV 范围为准：AIG 范围窄的版本也能命中，AIG 范围宽的不再误报', () => {
  assert.ok(cvesOf('package.json', '{"dependencies":{"n8n":"2.30.0"}}').includes('CVE-2026-86080'));
  assert.ok(cvesOf('requirements.txt', 'open-webui==0.3.0\n').includes('CVE-2024-6706'));
  assert.ok(cvesOf('requirements.txt', 'mlflow==3.0.0\n').includes('CVE-2024-37059'));
  assert.ok(!cvesOf('requirements.txt', 'langchain-core==0.3.90\n').includes('CVE-2025-65106'));
  assert.ok(cvesOf('requirements.txt', 'langchain-core==0.3.79\n').includes('CVE-2025-65106'));
});

test('清单解析：各格式行号、名称规范化、跳过 URL/可编辑/注释行', () => {
  const req = parseManifest('requirements.txt', '-r base.txt\n-e .\nLangChain_Core==0.1.20  # pin\ngit+https://x/y.git\nfoo @ https://x/foo.whl\n');
  assert.deepEqual(req.map((d) => [d.name, d.version, d.versionKind, d.line]), [['langchain-core', '0.1.20', 'exact', 3]]);
  const poetry = parseManifest('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.10"\nlangchain = "0.0.131"\nvllm = { version = "^0.8.0", extras = ["x"] }\nlocal = { path = "../x" }\n');
  assert.deepEqual(poetry.map((d) => [d.name, d.version, d.versionKind, d.line]), [['langchain', '0.0.131', 'exact', 3], ['vllm', '^0.8.0', 'range', 4]]);
  assert.deepEqual(parseManifest('package.json', '{not json'), []);
  assert.deepEqual(parseManifest('README.md', 'langchain==0.0.1'), []);
});
