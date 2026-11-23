/**
 * 生成已知开源模型库 apps/api/src/modules/model-files/data/known-models.jsonl。
 *
 * 来源（只取元数据和哈希，不下载模型文件）：
 *   1. 模型信息接口 <HF_ENDPOINT>/api/models/<仓库>：提交号、许可证（cardData.license）、基座（cardData.base_model）；
 *   2. 文件树接口 <HF_ENDPOINT>/api/models/<仓库>/tree/<提交号>?recursive=true：LFS 文件的 sha256（lfs.oid）和大小；
 *   3. 受限官方仓库（meta-llama、google 等，不登录时 lfs.oid 是星号）：清单里写 ms=<ModelScope 仓库>，
 *      从 ModelScope 文件接口 https://modelscope.cn/api/v1/models/<仓库>/repo/files 取 Sha256；
 *      只收路径和大小都与 Hugging Face 官方文件树一致的文件；
 *   4. 官方仓库的提交历史 <HF_ENDPOINT>/api/models/<仓库>/commits/main：逐个回看改动过权重的提交，
 *      收集现行版本已经换掉的旧权重哈希（每个仓库最多 10 个这样的提交，总请求数有上限，见 --history-budget）。
 * 只收权重类文件（扫描器会算哈希的扩展名）；非 LFS 文件没有 sha256，不收。
 *
 * 用法（在 apps/api 下）：
 *   HF_ENDPOINT=https://hf-mirror.com node --no-network-family-autoselection --import tsx \
 *     scripts/update-known-models.ts [--cache-dir <目录>] [--from-cache | --reuse-cache] [--only <仓库>] \
 *     [--no-history] [--history-budget <请求数>]
 * - 清单 scripts/known-models/repos.txt：每行「仓库 系列 类型 发布方 [选项]」，见该文件开头的说明。
 * - HF_ENDPOINT 默认 https://huggingface.co；国内直连不通时用镜像 https://hf-mirror.com（接口与官方一致）。
 *   数据里的 source 一律记 https://huggingface.co/<仓库>/tree/<提交号>（ModelScope 来源记 ModelScope 页面），镜像只用于拉取。
 * - 每个仓库拉到的接口原文缓存在 --cache-dir（默认 ~/.cache/lse-known-models）；--from-cache 不联网，用缓存重新生成；
 *   --reuse-cache 缓存里已有的仓库（含历史）不再联网，只拉缺的。
 * - 镜像有限频（HTTP 429），脚本会按 Retry-After 等待后重试。
 * - 拉取失败的仓库打印出来并跳过，不写入数据文件；全部失败时退出码为 1。
 * - Node 默认的地址族自动选择在部分网络下连不上，超时时加 --no-network-family-autoselection。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_MODEL_KINDS,
  KNOWN_MODELS_FILE,
  parseKnownModelLine,
  type KnownModel,
  type KnownModelFile,
  type KnownModelKind,
  type KnownModelPreviousFile,
} from '../src/modules/model-files/known-models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPOS_FILE = path.join(here, 'known-models/repos.txt');
/** 与扫描器的模型文件扩展名一致：只有这些文件会被算哈希、参与匹配。 */
const WEIGHT_EXT =
  /\.(?:safetensors|gguf|bin|pt|pth|ckpt|onnx|h5|hdf5|keras|npy|npz|pkl|pickle|joblib)$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const FROM_CACHE = process.argv.includes('--from-cache');
const REUSE_CACHE = process.argv.includes('--reuse-cache');
const NO_HISTORY = process.argv.includes('--no-history');
/** 两次请求之间的间隔，避免触发镜像限频。 */
const REQUEST_GAP_MS = 500;
const ONLY = arg('--only');
const CACHE_DIR = arg('--cache-dir') ?? path.join(homedir(), '.cache/lse-known-models');
const ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const MODELSCOPE = 'https://modelscope.cn';
/** 历史回看：每个仓库最多收 10 个改动过权重的提交、最多取 12 个提交的文件树；全部仓库合计的请求上限。 */
const HISTORY_MAX_CHANGES = 10;
const HISTORY_MAX_TREES_PER_REPO = 12;
const historyBudget = { left: Number(arg('--history-budget') ?? 1500) };

interface RepoLine {
  repo: string;
  family: string;
  kind: KnownModelKind;
  official: boolean;
  mirrorOf?: string;
  modelscope?: string;
}
interface TreeItem {
  type: string;
  path: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}
interface MsFile {
  Path: string;
  Type: string;
  Sha256?: string;
  Size?: number;
}
interface Cached {
  endpoint: string;
  fetchedAt: string;
  info: {
    id?: string;
    sha?: string;
    cardData?: { license?: unknown; base_model?: unknown };
    tags?: string[];
  };
  tree: TreeItem[];
  modelscope?: { repo: string; files: MsFile[] };
}
interface History {
  fetchedAt: string;
  commits: number;
  trees: number;
  files: KnownModelPreviousFile[];
}

function readRepoList(file: string): RepoLine[] {
  const out: RepoLine[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      const [repo, family, kind, publisher, ...opts] = line.split(/\s+/);
      if (
        !repo ||
        !family ||
        !KNOWN_MODEL_KINDS.includes(kind as KnownModelKind) ||
        (publisher !== '官方' && publisher !== '社区')
      )
        throw new Error(`repos.txt 第 ${i + 1} 行格式不对：${raw}`);
      const r: RepoLine = {
        repo,
        family,
        kind: kind as KnownModelKind,
        official: publisher === '官方',
      };
      for (const o of opts) {
        const [k, v] = o.split('=');
        if (k === 'mirror' && v) r.mirrorOf = v;
        else if (k === 'ms' && v) r.modelscope = v;
        else throw new Error(`repos.txt 第 ${i + 1} 行选项不认识：${o}`);
      }
      if (r.mirrorOf && r.official)
        throw new Error(`repos.txt 第 ${i + 1} 行：官方仓库不能写 mirror=`);
      out.push(r);
    });
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ body: unknown; next: string | null }> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await sleep(REQUEST_GAP_MS);
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'lse-known-models/1.1' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404 || res.status === 401)
        throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      if (res.status === 429) {
        // 镜像限频：按 Retry-After 等待，没有就等一分钟
        const wait = Number(res.headers.get('retry-after')) || 60;
        await sleep(wait * 1000);
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const link = res.headers.get('link') ?? '';
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      return { body: await res.json(), next };
    } catch (e) {
      last = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const cacheFile = (repo: string) => path.join(CACHE_DIR, `${repo.replace('/', '__')}.json`);
const historyFile = (repo: string) =>
  path.join(CACHE_DIR, `${repo.replace('/', '__')}.history.json`);

async function fetchTree(
  repo: string,
  rev: string,
  budget?: { left: number },
): Promise<TreeItem[]> {
  const tree: TreeItem[] = [];
  let url: string | null = `${ENDPOINT}/api/models/${repo}/tree/${rev}?recursive=true`;
  for (let page = 0; url && page < 50; page++) {
    if (budget) {
      if (budget.left <= 0) throw new Error('历史请求数用完');
      budget.left--;
    }
    const r = await getJson(url);
    tree.push(...(r.body as TreeItem[]));
    url = r.next ? new URL(r.next, ENDPOINT).toString() : null;
  }
  return tree;
}

async function fetchRepo(line: RepoLine): Promise<Cached> {
  const { body: info } = await getJson(`${ENDPOINT}/api/models/${line.repo}`);
  const i = info as Cached['info'];
  if (!i.sha) throw new Error('接口未返回提交号');
  const tree = await fetchTree(i.id ?? line.repo, i.sha);
  const cached: Cached = { endpoint: ENDPOINT, fetchedAt: new Date().toISOString(), info: i, tree };
  if (line.modelscope) {
    const { body } = await getJson(
      `${MODELSCOPE}/api/v1/models/${line.modelscope}/repo/files?Revision=master&Recursive=true`,
    );
    const files = ((body as { Data?: { Files?: MsFile[] } }).Data?.Files ?? []).filter(
      (f) => f.Type === 'blob',
    );
    if (!files.length) throw new Error(`ModelScope ${line.modelscope} 没有文件`);
    cached.modelscope = { repo: line.modelscope, files };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile(line.repo), JSON.stringify(cached));
  return cached;
}

/** 提交标题明显只改了说明、配置或代码的，不取文件树（省请求）；拿不准的都取。 */
const META_ONLY =
  /readme|license|model ?card|metadata|\.md\b|\.gitattributes|\bconfig\.json|tokenizer|chat[_ ]template|special_tokens|\.py\b|\.png\b|\.jpe?g\b|\.txt\b|initial commit|notice|use_policy|citation|typo/i;
const MAYBE_WEIGHTS =
  /safetensors|\.bin\b|\.gguf|\.pth?\b|\.onnx|weight|model-0|shard|upload folder|upload model|checkpoint|ckpt|fp16|bf16/i;

const weightFiles = (tree: TreeItem[]) =>
  tree.filter(
    (t) =>
      t.type === 'file' && WEIGHT_EXT.test(t.path) && SHA256.test(t.lfs?.oid?.toLowerCase() ?? ''),
  );

/** 官方仓库的历史权重：从新到旧回看提交，收集现行版本里没有的权重哈希。 */
async function fetchHistory(repo: string, c: Cached): Promise<History> {
  const { body } = await getJson(`${ENDPOINT}/api/models/${repo}/commits/main`);
  const commits = (body as Array<{ id: string; title?: string; date?: string }>) ?? [];
  const seen = new Set(weightFiles(c.tree).map((t) => t.lfs!.oid!.toLowerCase()));
  const files: KnownModelPreviousFile[] = [];
  const start = Math.max(
    0,
    commits.findIndex((x) => x.id === c.info.sha),
  );
  let changes = 0;
  let trees = 0;
  for (const commit of commits.slice(start + 1)) {
    if (changes >= HISTORY_MAX_CHANGES || trees >= HISTORY_MAX_TREES_PER_REPO) break;
    if (historyBudget.left <= 0) break;
    const title = commit.title ?? '';
    if (META_ONLY.test(title) && !MAYBE_WEIGHTS.test(title)) continue;
    trees++;
    let tree: TreeItem[];
    try {
      tree = await fetchTree(repo, commit.id, historyBudget);
    } catch (e) {
      if (historyBudget.left <= 0) break;
      throw e;
    }
    const fresh = weightFiles(tree).filter((t) => !seen.has(t.lfs!.oid!.toLowerCase()));
    if (!fresh.length) continue;
    changes++;
    for (const t of fresh) {
      const sha256 = t.lfs!.oid!.toLowerCase();
      seen.add(sha256);
      files.push({
        path: t.path,
        size: t.lfs!.size ?? t.size ?? 0,
        sha256,
        revision: commit.id,
        ...(commit.date ? { date: commit.date } : {}),
      });
    }
  }
  const h: History = { fetchedAt: new Date().toISOString(), commits: commits.length, trees, files };
  writeFileSync(historyFile(repo), JSON.stringify(h));
  return h;
}

function quantizationOf(repo: string): string | undefined {
  const n = repo.split('/')[1]!;
  if (/gguf/i.test(n)) return 'GGUF';
  if (/awq/i.test(n)) return 'AWQ';
  if (/gptq[-_]?int8/i.test(n)) return 'GPTQ-Int8';
  if (/gptq/i.test(n)) return 'GPTQ';
  if (/fp8/i.test(n)) return 'FP8';
  if (/bnb[-_]?4bit|4bit|4bits/i.test(n)) return 'bitsandbytes 4bit';
  if (/int4/i.test(n)) return 'Int4';
  if (/int8/i.test(n)) return 'Int8';
  return undefined;
}

const firstString = (v: unknown): string | undefined =>
  typeof v === 'string' && v
    ? v
    : Array.isArray(v)
      ? v.find((x): x is string => typeof x === 'string')
      : undefined;

function toRecord(line: RepoLine, c: Cached, history: History | null): KnownModel {
  const repo = c.info.id ?? line.repo;
  const [org, name] = repo.split('/') as [string, string];
  // 受限仓库：Hugging Face 只给大小，哈希从 ModelScope 取，路径和大小都一致才收
  const ms = new Map((c.modelscope?.files ?? []).map((f) => [f.Path, f] as const));
  let fromMs = 0;
  const files: KnownModelFile[] = [];
  for (const t of c.tree) {
    if (t.type !== 'file' || !t.lfs || !WEIGHT_EXT.test(t.path)) continue;
    const size = t.lfs.size ?? t.size ?? 0;
    const oid = t.lfs.oid?.toLowerCase() ?? '';
    if (SHA256.test(oid)) files.push({ path: t.path, size, sha256: oid });
    else {
      const m = ms.get(t.path);
      const sha = m?.Sha256?.toLowerCase() ?? '';
      if (m && m.Size === size && SHA256.test(sha)) {
        files.push({ path: t.path, size, sha256: sha });
        fromMs++;
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const license =
    firstString(c.info.cardData?.license) ??
    c.info.tags?.find((t) => t.startsWith('license:'))?.slice('license:'.length);
  const baseModel = firstString(c.info.cardData?.base_model);
  const quantization = line.kind === 'quantized' ? quantizationOf(repo) : undefined;
  const previous = (history?.files ?? []).slice(0, 200);
  const rec: KnownModel = {
    repo,
    name,
    family: line.family,
    org,
    kind: line.kind,
    official: line.official,
    ...(line.mirrorOf ? { mirrorOf: line.mirrorOf } : {}),
    ...(fromMs && c.modelscope ? { hashVia: `ModelScope ${c.modelscope.repo}` } : {}),
    ...(quantization ? { quantization } : {}),
    ...(baseModel && baseModel !== repo ? { baseModel } : {}),
    ...(license ? { license } : {}),
    files,
    ...(previous.length ? { previousFiles: previous } : {}),
    source:
      fromMs && c.modelscope
        ? `${MODELSCOPE}/models/${c.modelscope.repo}/files`
        : `https://huggingface.co/${repo}/tree/${c.info.sha}`,
    fetchedAt: c.fetchedAt,
  };
  // 与运行时同一套校验，不合规的记录不写入
  return parseKnownModelLine(JSON.stringify(rec));
}

/**
 * 社区转存逐个文件与官方比对：哈希在官方文件（含旧版本）里 → 一致；
 * 官方同路径文件哈希已知但不同、大小不同或官方没有这个路径 → 重新保存过；其余（只知道大小且相同）不写。
 */
function markMirror(
  rec: KnownModel,
  official: KnownModel | undefined,
  officialTree: TreeItem[] | null,
) {
  const shas = new Set([
    ...(official?.files ?? []).map((f) => f.sha256),
    ...(official?.previousFiles ?? []).map((f) => f.sha256),
  ]);
  const byPath = new Map((official?.files ?? []).map((f) => [f.path, f]));
  const sizes = new Map(
    (officialTree ?? [])
      .filter((t) => t.type === 'file' && WEIGHT_EXT.test(t.path))
      .map((t) => [t.path, t.lfs?.size ?? t.size ?? 0]),
  );
  for (const f of rec.files) {
    if (shas.has(f.sha256)) f.identicalToOfficial = true;
    else if (byPath.has(f.path)) f.identicalToOfficial = false;
    else if (officialTree && (!sizes.has(f.path) || sizes.get(f.path) !== f.size))
      f.identicalToOfficial = false;
    else delete f.identicalToOfficial;
  }
}

async function main() {
  const all = readRepoList(REPOS_FILE);
  const seen = new Set<string>();
  for (const l of all) {
    if (seen.has(l.repo.toLowerCase())) throw new Error(`repos.txt 重复：${l.repo}`);
    seen.add(l.repo.toLowerCase());
  }
  const lines = ONLY ? all.filter((l) => l.repo === ONLY) : all;
  const results: Array<KnownModel | null> = new Array(lines.length).fill(null);
  const trees = new Map<string, TreeItem[]>();
  const failures: string[] = [];
  let historyRepos = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < lines.length) {
      const idx = cursor++;
      const line = lines[idx]!;
      try {
        const cached =
          FROM_CACHE || (REUSE_CACHE && existsSync(cacheFile(line.repo)))
            ? (JSON.parse(readFileSync(cacheFile(line.repo), 'utf8')) as Cached)
            : await fetchRepo(line);
        trees.set(line.repo, cached.tree);
        let history: History | null = null;
        // 历史只对 Hugging Face 上拿得到哈希的官方仓库回看（受限仓库的旧版本拿不到哈希）
        if (line.official && !line.modelscope && !NO_HISTORY) {
          if (FROM_CACHE || (REUSE_CACHE && existsSync(historyFile(line.repo)))) {
            if (existsSync(historyFile(line.repo)))
              history = JSON.parse(readFileSync(historyFile(line.repo), 'utf8')) as History;
          } else {
            try {
              history = await fetchHistory(line.repo, cached);
            } catch (e) {
              console.log(`warn ${line.repo}  历史未取到：${e instanceof Error ? e.message : e}`);
            }
          }
          if (history?.files.length) historyRepos++;
        }
        const rec = toRecord(line, cached, history);
        results[idx] = rec;
        console.log(
          `ok   ${line.repo}  ${rec.files.length} 个文件${rec.previousFiles ? `，历史 ${rec.previousFiles.length} 个` : ''}${rec.hashVia ? `（哈希经 ${rec.hashVia}）` : ''}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${line.repo}：${msg}`);
        console.log(`fail ${line.repo}  ${msg}`);
      }
    }
  }
  await Promise.all(Array.from({ length: FROM_CACHE ? 1 : 2 }, worker));
  let records = results.filter((r): r is KnownModel => r !== null);
  if (ONLY && existsSync(KNOWN_MODELS_FILE)) {
    // 只更新一个仓库时，保留数据文件里的其他仓库，顺序按清单
    const old = readFileSync(KNOWN_MODELS_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map(parseKnownModelLine)
      .filter((m) => m.repo !== records[0]?.repo);
    const order = new Map(all.map((l, i) => [l.repo.toLowerCase(), i]));
    records = [...old, ...records].sort(
      (a, b) => (order.get(a.repo.toLowerCase()) ?? 1e9) - (order.get(b.repo.toLowerCase()) ?? 1e9),
    );
  }
  // 社区转存与官方逐个文件比对
  const byRepo = new Map(records.map((r) => [r.repo, r]));
  const unchecked: string[] = [];
  for (const r of records) {
    if (!r.mirrorOf) continue;
    let tree = trees.get(r.mirrorOf) ?? null;
    if (!tree && existsSync(cacheFile(r.mirrorOf)))
      tree = (JSON.parse(readFileSync(cacheFile(r.mirrorOf), 'utf8')) as Cached).tree;
    markMirror(r, byRepo.get(r.mirrorOf), tree);
    const n = r.files.filter((f) => f.identicalToOfficial === undefined).length;
    if (n) unchecked.push(`${r.repo}：${n} 个文件无法与 ${r.mirrorOf} 核对`);
  }
  if (!records.length) {
    console.error('没有拉到任何仓库，数据文件未改动');
    process.exit(1);
  }
  const dupes = new Set<string>();
  const uniq = records.filter((r) => (dupes.has(r.repo) ? false : (dupes.add(r.repo), true)));
  const tmp = `${KNOWN_MODELS_FILE}.tmp`;
  writeFileSync(
    tmp,
    uniq.map((r) => JSON.stringify(parseKnownModelLine(JSON.stringify(r)))).join('\n') + '\n',
  );
  renameSync(tmp, KNOWN_MODELS_FILE);
  const fileCount = uniq.reduce((n, r) => n + r.files.length, 0);
  const prevCount = uniq.reduce((n, r) => n + (r.previousFiles?.length ?? 0), 0);
  const official = uniq.filter((r) => r.official).length;
  const mirrors = uniq.filter((r) => r.mirrorOf);
  const same = mirrors.reduce(
    (n, r) => n + r.files.filter((f) => f.identicalToOfficial === true).length,
    0,
  );
  const resaved = mirrors.reduce(
    (n, r) => n + r.files.filter((f) => f.identicalToOfficial === false).length,
    0,
  );
  console.log(
    `\n写入 ${uniq.length} 个仓库（官方 ${official}、社区 ${uniq.length - official}，其中转存 ${mirrors.length}）、` +
      `${fileCount} 个文件、官方旧版本 ${prevCount} 个（${historyRepos} 个仓库）→ ${path.relative(process.cwd(), KNOWN_MODELS_FILE)}`,
  );
  console.log(
    `转存文件与官方一致 ${same} 个、重新保存 ${resaved} 个；历史请求余量 ${historyBudget.left}`,
  );
  if (unchecked.length) console.log(`未能核对：\n  ${unchecked.join('\n  ')}`);
  if (failures.length) console.log(`未拉到 ${failures.length} 个：\n  ${failures.join('\n  ')}`);
}

await main();
