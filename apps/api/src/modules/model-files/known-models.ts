import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FormatScan, ModelFinding } from './types.js';

/**
 * 已知开源模型库：data/known-models.jsonl，每行一个 Hugging Face 仓库及其 LFS 文件的 sha256。
 * 由 scripts/update-known-models.ts 按 scripts/known-models/repos.txt 生成；运行时只读，首次使用时加载。
 */
export const KNOWN_MODEL_KINDS = ['base', 'instruct', 'quantized', 'lora', 'merged'] as const;
export type KnownModelKind = (typeof KNOWN_MODEL_KINDS)[number];
export const KNOWN_MODEL_KIND_LABELS: Record<KnownModelKind, string> = {
  base: '基座',
  instruct: '指令微调',
  quantized: '量化',
  lora: 'LoRA 适配器',
  merged: '合并',
};

export interface KnownModelFile {
  path: string;
  size: number;
  sha256: string;
  /** 社区转存（mirrorOf）的文件：与官方发布的文件哈希一致为 true，重新保存过为 false，无法核对时不写 */
  identicalToOfficial?: boolean;
}
/** 官方仓库历史提交里出现过、现行版本已经换掉的权重文件。 */
export interface KnownModelPreviousFile extends KnownModelFile {
  revision: string;
  date?: string;
}
export interface KnownModel {
  repo: string;
  name: string;
  family: string;
  org: string;
  kind: KnownModelKind;
  /** 模型厂商自己的组织发布（repos.txt 标为官方） */
  official?: boolean;
  /** 社区转存的是哪个官方仓库（官方仓库受限、拿不到哈希时收录的副本） */
  mirrorOf?: string;
  /** 哈希不是取自本仓库时注明出处，如「ModelScope LLM-Research/Meta-Llama-3-8B」 */
  hashVia?: string;
  quantization?: string;
  baseModel?: string;
  license?: string;
  files: KnownModelFile[];
  previousFiles?: KnownModelPreviousFile[];
  source: string;
  fetchedAt: string;
}

export const KNOWN_MODELS_FILE = fileURLToPath(
  new URL('./data/known-models.jsonl', import.meta.url),
);

const SHA256 = /^[0-9a-f]{64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const str = (v: unknown) => typeof v === 'string' && v.length > 0;
const optStr = (v: unknown) => v === undefined || str(v);
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';

function checkFile(f: Record<string, unknown>, previous = false) {
  if (!f || !str(f.path)) throw new Error('文件 path 缺失');
  if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0)
    throw new Error(`文件 size 无效：${String(f.path)}`);
  if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256))
    throw new Error(`文件 sha256 无效：${String(f.path)}`);
  if (!optBool(f.identicalToOfficial))
    throw new Error(`文件 identicalToOfficial 无效：${String(f.path)}`);
  if (previous && (!str(f.revision) || !optStr(f.date)))
    throw new Error(`历史文件 revision 无效：${String(f.path)}`);
}

/** 解析数据文件的一行，结构不合规时抛错。 */
export function parseKnownModelLine(line: string): KnownModel {
  const v = JSON.parse(line) as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('不是 JSON 对象');
  if (typeof v.repo !== 'string' || !REPO.test(v.repo)) throw new Error('repo 无效');
  for (const k of ['name', 'family', 'org', 'source', 'fetchedAt'] as const)
    if (!str(v[k])) throw new Error(`${k} 缺失`);
  if (!KNOWN_MODEL_KINDS.includes(v.kind as KnownModelKind)) throw new Error('kind 无效');
  for (const k of ['quantization', 'baseModel', 'license', 'hashVia'] as const)
    if (!optStr(v[k])) throw new Error(`${k} 无效`);
  if (!optBool(v.official)) throw new Error('official 无效');
  if (v.mirrorOf !== undefined && (typeof v.mirrorOf !== 'string' || !REPO.test(v.mirrorOf)))
    throw new Error('mirrorOf 无效');
  if (!Array.isArray(v.files) || v.files.length === 0) throw new Error('files 为空');
  for (const f of v.files as Array<Record<string, unknown>>) checkFile(f);
  if (v.previousFiles !== undefined) {
    if (!Array.isArray(v.previousFiles)) throw new Error('previousFiles 无效');
    for (const f of v.previousFiles as Array<Record<string, unknown>>) checkFile(f, true);
  }
  return v as unknown as KnownModel;
}

export interface KnownModelsLoad {
  models: KnownModel[];
  /** 跳过的无效行（line 为行号；数据文件读不出来时为 0） */
  invalid: Array<{ line: number; error: string }>;
}

/** 读取数据文件；坏行跳过并记下，不让整个库不可用。 */
export function readKnownModels(file: string = KNOWN_MODELS_FILE): KnownModelsLoad {
  const out: KnownModelsLoad = { models: [], invalid: [] };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    out.invalid.push({
      line: 0,
      error: `无法读取数据文件：${e instanceof Error ? e.message : String(e)}`,
    });
    return out;
  }
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.models.push(parseKnownModelLine(line));
    } catch (e) {
      out.invalid.push({ line: i + 1, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return out;
}

export function loadKnownModels(file: string = KNOWN_MODELS_FILE): KnownModel[] {
  return readKnownModels(file).models;
}

interface Entry {
  model: KnownModel;
  file: KnownModelFile;
  /** 命中的是官方旧版本 */
  previous?: KnownModelPreviousFile;
}
export interface KnownModelIndex {
  models: KnownModel[];
  /** sha256 → 收录该文件的全部仓库（现行文件按清单顺序在前，官方旧版本在后） */
  bySha: Map<string, Entry[]>;
  /** 文件名（小写，不含目录）→ 收录了同名现行文件的仓库 */
  byName: Map<string, Entry[]>;
  invalid: KnownModelsLoad['invalid'];
}

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();
const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
};
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

export function buildKnownModelIndex(
  models: KnownModel[],
  invalid: KnownModelsLoad['invalid'] = [],
): KnownModelIndex {
  const bySha = new Map<string, Entry[]>();
  const byName = new Map<string, Entry[]>();
  for (const model of models)
    for (const file of model.files) {
      push(bySha, file.sha256, { model, file });
      push(byName, baseName(file.path), { model, file });
    }
  for (const model of models)
    for (const previous of model.previousFiles ?? [])
      push(bySha, previous.sha256, { model, file: previous, previous });
  return { models, bySha, byName, invalid };
}

let cached: KnownModelIndex | null = null;
/** 首次调用时读取数据文件并建索引，之后复用。 */
export function knownModelIndex(): KnownModelIndex {
  if (!cached) {
    const r = readKnownModels();
    cached = buildKnownModelIndex(r.models, r.invalid);
  }
  return cached;
}

/** 文件名里的量化类型或精度（Q4_K_M、IQ4_XS、F16，以及 fp16、bf16 写法）。 */
const GGUF_QUANT =
  /(?:^|[-_.])((?:IQ[1-4]_(?:XXS|XS|S|M|NL)|Q[2-8]_K(?:_[SMLX]L?)?|Q[4-8]_[01]|TQ[12]_0|MXFP4(?:_MOE)?|BF16|FP16|FP32|F16|F32))(?=[-_.])/i;
export function quantizationFromFileName(path: string): string | undefined {
  const m = GGUF_QUANT.exec(baseName(path));
  if (!m) return undefined;
  const q = m[1]!.toUpperCase();
  return q === 'FP16' ? 'F16' : q === 'FP32' ? 'F32' : q;
}
/** 不是量化的精度：量化仓库里的这类文件只是格式转换。 */
export const UNQUANTIZED_TYPES: ReadonlySet<string> = new Set(['F32', 'F16', 'BF16']);

export interface KnownModelIdentity {
  /** 展示的仓库：与官方一致的社区转存显示官方仓库 */
  repo: string;
  name: string;
  family: string;
  kind: KnownModelKind;
  kindLabel: string;
  /** 官方发布的文件（官方仓库，或与官方一致的转存） */
  official: boolean;
  /** 哈希经哪里核对：官方仓库的哈希取自社区转存或 ModelScope 时注明 */
  verifiedVia?: string;
  /** 社区转存但不是官方原文件：重新保存过（true）或无法核对（false） */
  copyOf?: { repo: string; publisher: string; resaved: boolean };
  /** 命中官方仓库历史提交里的旧版本 */
  previous?: { revision: string; date?: string };
  quantization?: string;
  baseModel?: string;
  license?: string;
  /** 已知库里对应文件在仓库中的路径 */
  file: string;
  source: string;
}
export interface KnownModelMatch {
  known: KnownModelIdentity | null;
  label: string;
  findings: ModelFinding[];
}

export const UNKNOWN_MODEL_LABEL = '未在已知模型库中';

const hfPage = (repo: string, rev?: string) =>
  `https://huggingface.co/${repo}${rev ? `/tree/${rev}` : ''}`;

/** 这个已知文件是否代表官方发布的文件。 */
const isOfficialEntry = (e: Entry) =>
  e.model.mirrorOf ? e.file.identicalToOfficial === true : e.model.official === true;
/** 展示用的仓库：与官方一致的转存归到官方仓库。 */
const shownRepo = (e: Entry) =>
  e.model.mirrorOf && e.file.identicalToOfficial === true ? e.model.mirrorOf : e.model.repo;

function identity({ model, file, previous }: Entry): KnownModelIdentity {
  const quantization =
    model.kind === 'quantized'
      ? (quantizationFromFileName(file.path) ?? model.quantization)
      : undefined;
  const asOfficial = Boolean(model.mirrorOf && file.identicalToOfficial === true);
  const repo = asOfficial ? model.mirrorOf! : model.repo;
  return {
    repo,
    name: asOfficial ? repo.split('/')[1]! : model.name,
    family: model.family,
    kind: model.kind,
    kindLabel: KNOWN_MODEL_KIND_LABELS[model.kind],
    official: asOfficial || (!model.mirrorOf && model.official === true),
    ...(asOfficial
      ? { verifiedVia: model.repo }
      : model.hashVia && !model.mirrorOf
        ? { verifiedVia: model.hashVia }
        : {}),
    ...(model.mirrorOf && !asOfficial
      ? {
          copyOf: {
            repo: model.mirrorOf,
            publisher: model.org,
            resaved: file.identicalToOfficial === false,
          },
        }
      : {}),
    ...(previous
      ? {
          previous: {
            revision: previous.revision,
            ...(previous.date ? { date: previous.date } : {}),
          },
        }
      : {}),
    ...(quantization ? { quantization } : {}),
    ...(model.baseModel ? { baseModel: model.baseModel } : {}),
    ...(model.license ? { license: model.license } : {}),
    file: file.path,
    source: previous
      ? hfPage(model.repo, previous.revision)
      : asOfficial
        ? hfPage(repo)
        : model.source,
  };
}

function labelOf(k: KnownModelIdentity): string {
  if (k.copyOf)
    return `已知模型：${k.name}（${k.copyOf.publisher} ${k.copyOf.resaved ? '重新保存版' : '转存版'}）`;
  if (k.previous) return `已知模型：${k.name}（${k.kindLabel}，官方旧版本）`;
  return `已知模型：${k.name}（${k.kindLabel}）`;
}

/** 路径里出现仓库名（目录名等于仓库名，或 HF 缓存目录 models--组织--仓库）。 */
function pathPointsTo(fullPath: string, repo: string): boolean {
  const p = fullPath.toLowerCase().replace(/\\/g, '/');
  const [org, name] = repo.toLowerCase().split('/') as [string, string];
  if (p.includes(`models--${org}--${name}/`)) return true;
  return p.split('/').slice(0, -1).includes(name);
}

/** 仓库名里不能代表模型身份的词（类型、格式、量化标记）。 */
const GENERIC_TOKENS = new Set([
  'instruct',
  'chat',
  'base',
  'model',
  'gguf',
  'awq',
  'gptq',
  'int4',
  'int8',
  'fp8',
  'bnb',
  '4bit',
  '4bits',
  'hf',
]);
/**
 * 文件名本身带着仓库名（如 qwen2.5-7b-instruct-q4_k_m.gguf），才能单凭文件名对应到仓库；
 * model-00001-of-00037.safetensors 这类通用分片名只是恰好只在库里一个仓库出现，不算。
 */
function nameCarriesRepo(fileName: string, repo: string): boolean {
  const n = baseName(fileName);
  return repo
    .split('/')[1]!
    .toLowerCase()
    .split(/[-_.]/)
    .some(
      (t) => t.length >= 3 && !/^\d+[a-z]?$/.test(t) && !GENERIC_TOKENS.has(t) && n.includes(t),
    );
}

const short = (sha: string) => `${sha.slice(0, 16)}…`;

function mismatchFinding(
  f: { path: string; sha256: string; bytes?: number },
  pick: Entry,
): ModelFinding {
  const official = isOfficialEntry(pick);
  const repo = shownRepo(pick);
  const where = official ? `官方仓库 ${repo}` : repo;
  if (f.bytes !== undefined && f.bytes !== pick.file.size)
    return {
      ruleId: 'KNOWN_MODEL_NAME_ONLY',
      severity: 'INFO',
      title: '同名但不是同一文件',
      detail:
        `${f.path} 与 ${where} 的同名文件 ${pick.file.path} 大小不同` +
        `（已知 ${pick.file.size} 字节，实际 ${f.bytes} 字节），不是同一文件，` +
        '可能是其他发布者的版本或本地重新生成',
    };
  return {
    ruleId: 'KNOWN_MODEL_HASH_MISMATCH',
    severity: 'HIGH',
    title: '与已知发布文件不一致',
    detail:
      `${f.path} 与 ${where} 发布的同名文件 ${pick.file.path} 大小相同但哈希不一致` +
      `（${official ? '官方' : '已知'} sha256 ${short(pick.file.sha256)}，实际 ${short(f.sha256)}）。` +
      `可能被篡改或替换，请从${official ? '官方' : '该'}仓库重新下载核对`,
  };
}

/**
 * 按 sha256 匹配已知模型。一个哈希可能收录在多个仓库（官方与转存、不同量化仓库），
 * 优先取同目录其他文件也命中的仓库，其次按清单顺序（官方在前）。
 * 不命中时，若能确定该文件对应的已知仓库，再比同名文件：
 * - 同目录有别的文件命中了这个仓库；或
 * - 所在路径带有这个仓库名（目录名、HF 缓存目录）；或
 * - 这个文件名在已知库里只属于一个官方仓库，且文件名本身带着仓库名（社区仓库的同名文件不算，
 *   lmstudio-community、second-state 等常用同样的文件名发布各自的量化）。
 * 确定后：大小相同、哈希不同报高危「与已知发布文件不一致」；大小不同只提示「同名但不是同一文件」。
 * root 为目录扫描的根（真实路径），上传扫描传空串。
 */
export function matchKnownModels(
  index: KnownModelIndex,
  files: Array<{ path: string; sha256: string; bytes?: number }>,
  root = '',
): KnownModelMatch[] {
  const hits = files.map((f) => index.bySha.get(f.sha256.toLowerCase()) ?? []);
  const dirRepos = new Map<string, Map<string, number>>();
  files.forEach((f, i) => {
    if (!hits[i]!.length) return;
    const d = dirOf(f.path);
    const counts = dirRepos.get(d) ?? new Map<string, number>();
    for (const repo of new Set(hits[i]!.map((h) => h.model.repo)))
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    dirRepos.set(d, counts);
  });
  return files.map((f, i): KnownModelMatch => {
    const inDir = dirRepos.get(dirOf(f.path));
    const list = hits[i]!;
    if (list.length) {
      let best = list[0]!;
      for (const h of list)
        if ((inDir?.get(h.model.repo) ?? 0) > (inDir?.get(best.model.repo) ?? 0)) best = h;
      const known = identity(best);
      return {
        known,
        label: labelOf(known),
        findings: best.previous
          ? [
              {
                ruleId: 'KNOWN_MODEL_OLD_VERSION',
                severity: 'INFO',
                title: '官方旧版本',
                detail:
                  `${f.path} 是 ${best.model.repo} 在提交 ${best.previous.revision.slice(0, 12)}` +
                  `${best.previous.date ? `（${best.previous.date.slice(0, 10)}）` : ''} 时发布的 ${best.previous.path}，` +
                  '官方之后已更新该文件',
              },
            ]
          : [],
      };
    }
    const unknown: KnownModelMatch = { known: null, label: UNKNOWN_MODEL_LABEL, findings: [] };
    const candidates = index.byName.get(baseName(f.path)) ?? [];
    if (!candidates.length) return unknown;
    const full = !root
      ? f.path
      : root.endsWith(f.path)
        ? root
        : `${root.replace(/[\\/]+$/, '')}/${f.path}`;
    const repos = new Set(candidates.map(shownRepo));
    const only = candidates[0]!;
    const pick =
      candidates.find((c) => inDir?.has(c.model.repo)) ??
      candidates.find((c) => pathPointsTo(full, c.model.repo)) ??
      (repos.size === 1 && isOfficialEntry(only) && nameCarriesRepo(f.path, shownRepo(only))
        ? only
        : undefined);
    if (!pick) return unknown;
    return { ...unknown, findings: [mismatchFinding(f, pick)] };
  });
}

/**
 * 已知模型识别写进各文件 meta（knownModel、knownModelLabel），不一致的追加问题。
 * 数据文件有坏行时在第一个文件上补一条提示（坏行已跳过，其余条目照常匹配）。
 */
export function applyKnownModels<
  T extends FormatScan & { path: string; sha256: string; bytes?: number },
>(files: T[], root: string, index: KnownModelIndex = knownModelIndex()): T[] {
  const matches = matchKnownModels(index, files, root);
  const bad = index.invalid;
  return files.map((f, i) => {
    const m = matches[i]!;
    const note: ModelFinding[] =
      i === 0 && bad.length
        ? [
            {
              ruleId: 'KNOWN_MODELS_DATA_INVALID',
              severity: 'LOW',
              title: '已知模型库有无效数据',
              detail:
                `已知模型库有 ${bad.length} 处无效，已跳过：` +
                bad
                  .slice(0, 5)
                  .map((b) => (b.line ? `第 ${b.line} 行（${b.error}）` : b.error))
                  .join('；'),
            },
          ]
        : [];
    return {
      ...f,
      findings: [...f.findings, ...m.findings, ...note],
      meta: { ...f.meta, knownModel: m.known, knownModelLabel: m.label },
    };
  });
}
