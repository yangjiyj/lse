// 语料扫描命令行版：离线扫描训练、微调语料的违规内容（国标关键词）、敏感信息和自定义规则，
// 检测核心与平台服务端共用（apps/api/src/modules/corpus-scans/core），统计口径一致。
// 用 node --experimental-strip-types 直接运行，不需要安装依赖；只用可擦除的 TS 语法。
// 打包脚本（apps/api/scripts/pack-corpus-cli.ts）会把下面的 core 路径改成 ./core/、写入版本号。
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_FORMATS,
  type CorpusFormat,
} from '../../apps/api/src/modules/corpus-scans/core/formats.ts';
import {
  parseRuleImport,
  type CustomRule,
} from '../../apps/api/src/modules/corpus-scans/core/custom-rules.ts';
import {
  MAX_STORED_FINDINGS,
  createScanSession,
  type CorpusFindingOut,
} from '../../apps/api/src/modules/corpus-scans/core/scan.ts';

const CLI_VERSION = 'dev';
const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `用法：node --experimental-strip-types cli.ts <语料文件> [选项]

选项：
  --format <格式>       auto（默认）、alpaca、sharegpt、messages、prompt_completion、chosen_rejected、csv、txt
  --keywords <文件>     国标关键词 JSON（默认用 cli.ts 同目录的 keywords.json）
  --rules <文件>        自定义规则：CSV（表头 类型,内容,类别,严重度,启用）或 TXT（每行一个关键词）
  --csv-columns <列>    CSV 只检测这些列，逗号分隔
  --out <文件>          报告 JSON 写到这个文件（默认输出到标准输出）
  --max-findings <数>   报告里最多列出的命中条数（默认 ${MAX_STORED_FINDINGS}）
  --no-sensitive        不检测敏感信息
  -h, --help            显示这段帮助`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

interface Options {
  file: string;
  format: CorpusFormat;
  keywords: string | null;
  rules: string | null;
  csvColumns: string[];
  out: string | null;
  maxFindings: number;
  sensitive: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    file: '',
    format: 'auto',
    keywords: null,
    rules: null,
    csvColumns: [],
    out: null,
    maxFindings: MAX_STORED_FINDINGS,
    sensitive: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} 后面要跟一个值`);
      i += 1;
      return v;
    };
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--format') {
      const f = value();
      if (!(CORPUS_FORMATS as readonly string[]).includes(f)) fail(`不认识的格式：${f}`);
      opts.format = f as CorpusFormat;
    } else if (a === '--keywords') opts.keywords = value();
    else if (a === '--rules') opts.rules = value();
    else if (a === '--csv-columns') {
      opts.csvColumns = value()
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (a === '--out') opts.out = value();
    else if (a === '--max-findings') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) fail('--max-findings 要是不小于 0 的整数');
      opts.maxFindings = n;
    } else if (a === '--no-sensitive') opts.sensitive = false;
    else if (a.startsWith('-')) fail(`不认识的选项：${a}`);
    else if (!opts.file) opts.file = a;
    else fail(`多余的参数：${a}`);
  }
  if (!opts.file) fail('请给出要扫描的语料文件');
  return opts;
}

function loadKeywords(path: string | null): {
  keywords: { term: string; code: string }[];
  labels: Record<string, string>;
  source: string | null;
} {
  const file = path ? resolve(path) : join(HERE, 'keywords.json');
  if (!existsSync(file)) {
    if (path) fail(`找不到关键词文件：${path}`);
    return { keywords: [], labels: {}, source: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`关键词文件不是合法的 JSON：${file}`);
  }
  const obj = json as { keywords?: unknown; items?: unknown };
  if (!obj || !Array.isArray(obj.keywords)) fail(`关键词文件里没有 keywords 数组：${file}`);
  const keywords = (obj.keywords as { term?: unknown; code?: unknown }[])
    .filter((k) => typeof k?.term === 'string' && typeof k?.code === 'string')
    .map((k) => ({ term: k.term as string, code: k.code as string }));
  const labels =
    obj.items && typeof obj.items === 'object' ? (obj.items as Record<string, string>) : {};
  return { keywords, labels, source: file };
}

function loadRules(path: string | null): CustomRule[] {
  if (!path) return [];
  const file = resolve(path);
  if (!existsSync(file)) fail(`找不到规则文件：${path}`);
  const ext = extname(file).toLowerCase();
  if (ext === '.xlsx') fail('命令行版不读 xlsx，请另存为 CSV（UTF-8）');
  const parsed = parseRuleImport(ext === '.txt' ? 'txt' : 'csv', readFileSync(file, 'utf8'), {
    category: '自定义',
    severity: 'MEDIUM',
  });
  for (const issue of parsed.issues.slice(0, 20)) {
    process.stderr.write(`规则文件第 ${issue.row} 行：${issue.message}\n`);
  }
  if (parsed.issues.length > 20)
    process.stderr.write(`……另有 ${parsed.issues.length - 20} 行有问题\n`);
  return parsed.rows.map((r, i) => ({ ...r, id: `rule-${i + 1}` }));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const file = resolve(opts.file);
  if (!existsSync(file) || !statSync(file).isFile()) fail(`找不到文件：${opts.file}`);
  const kw = loadKeywords(opts.keywords);
  if (!kw.source) process.stderr.write('没有关键词文件，不检测违规内容\n');
  const rules = loadRules(opts.rules);

  const session = createScanSession(
    { format: opts.format, fileName: basename(file), csvColumns: opts.csvColumns },
    { keywords: kw.keywords, codeLabels: kw.labels, customRules: rules, sensitive: opts.sensitive },
  );
  const findings: CorpusFindingOut[] = [];
  const keep = (found: CorpusFindingOut[]) => {
    for (const f of found) {
      if (findings.length >= opts.maxFindings) return;
      findings.push(f);
    }
  };
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
    const text = decoder.write(buf);
    if (text) keep(session.push(text));
  }
  const tail = decoder.end();
  if (tail) keep(session.push(tail));
  keep(session.end());
  const stats = session.stats();

  const report = {
    tool: 'lse-corpus-scan-cli',
    version: CLI_VERSION,
    scannedAt: new Date().toISOString(),
    file: { name: basename(file), bytes, sha256: hash.digest('hex') },
    format: opts.format,
    keywords: kw.keywords.length,
    rules: rules.length,
    stats,
    truncated: stats.findingCount > findings.length,
    findings,
  };
  const json = JSON.stringify(report, null, 2);
  if (opts.out) writeFileSync(resolve(opts.out), json);
  else process.stdout.write(`${json}\n`);

  const c = stats.byCategory;
  process.stderr.write(
    `记录 ${stats.totalRecords} 条（非法 ${stats.invalidRecords} 条），命中 ${stats.findingCount} 条：` +
      `违规内容 ${c.violation}、敏感信息 ${c.sensitive}、自定义规则 ${c.custom}\n`,
  );
  if (stats.cappedFindings > 0)
    process.stderr.write(`单条记录某类命中超过 1000 条，${stats.cappedFindings} 条只计数没列出\n`);
  for (const r of stats.disabledRules) process.stderr.write(`规则「${r.pattern}」超时已停用\n`);
  if (stats.regexTruncatedFields > 0)
    process.stderr.write(
      `${stats.regexTruncatedFields} 个字段超过 10 万字，自定义正则只检查了前 10 万字\n`,
    );
  if (stats.regexRulesIgnored > 0)
    process.stderr.write(`正则规则超过 500 条，后面 ${stats.regexRulesIgnored} 条没有参与\n`);
  if (opts.out) process.stderr.write(`报告已写入 ${resolve(opts.out)}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
