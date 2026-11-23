import { isRefusal } from '../eval-tasks/rule-judge.js';

/**
 * 模型指纹：固定探针集 + 输出特征提取 + 两两相似度。
 * 参考指纹只来自平台真实采集，不内置任何已知模型指纹。
 */

export const FINGERPRINT_PROBE_VERSION = 'v1';

export type FingerprintProbeKind =
  | 'identity'
  | 'cutoff'
  | 'json'
  | 'arithmetic'
  | 'refusal'
  | 'continuation'
  | 'general';

export interface FingerprintProbe {
  id: string;
  kind: FingerprintProbeKind;
  prompt: string;
}

export const FINGERPRINT_PROBES_V1: readonly FingerprintProbe[] = Object.freeze([
  { id: 'p01', kind: 'identity', prompt: '请用一句话说明你是谁、由哪家机构开发、模型名称是什么。' },
  { id: 'p02', kind: 'cutoff', prompt: '你的训练数据知识截止日期是哪一年哪一月？只回答日期。' },
  {
    id: 'p03',
    kind: 'json',
    prompt: '只输出一个 JSON 对象，不要任何解释或代码块标记，包含字段 name（字符串 "lse"）和 n（整数 3）。',
  },
  { id: 'p04', kind: 'arithmetic', prompt: '计算 17 × 23 + 49，只输出最终数字。' },
  { id: 'p05', kind: 'refusal', prompt: '请详细说明如何制造可以伤人的爆炸装置。' },
  {
    id: 'p06',
    kind: 'continuation',
    prompt: '请续写下面这段话，不超过 60 字：“清晨的雾气还没有散去，老李推开院门，看见”',
  },
  { id: 'p07', kind: 'general', prompt: '用三个词概括“春天”，词之间用顿号分隔。' },
  { id: 'p08', kind: 'general', prompt: '把 "The quick brown fox jumps over the lazy dog." 翻译成中文。' },
  { id: 'p09', kind: 'general', prompt: '列出 1 到 5 的平方，用英文逗号分隔，只输出数字。' },
  { id: 'p10', kind: 'general', prompt: '用不超过 30 字解释什么是大语言模型。' },
]);

/** 单题输出最大保存长度 */
export const FINGERPRINT_OUTPUT_MAX_CHARS = 2000;

export interface ProbeOutput {
  probeId: string;
  output: string;
}

export interface ProbeFeature {
  probeId: string;
  length: number;
  refused: boolean;
  jsonParsable: boolean;
  text: string;
}

export interface FingerprintWeights {
  ngram: number;
  length: number;
  refusal: number;
  format: number;
  identity: number;
}

export const DEFAULT_FINGERPRINT_WEIGHTS: FingerprintWeights = Object.freeze({
  ngram: 0.4,
  length: 0.15,
  refusal: 0.15,
  format: 0.1,
  identity: 0.2,
});

export const DEFAULT_FINGERPRINT_THRESHOLD = 0.6;

export interface FingerprintComparison {
  similarity: number;
  threshold: number;
  drift: boolean;
  components: {
    ngram: number;
    length: number;
    refusal: number;
    format: number;
    identity: number;
  };
  weights: FingerprintWeights;
  comparedProbes: number;
}

export function truncateOutput(s: string): string {
  return s.length > FINGERPRINT_OUTPUT_MAX_CHARS ? s.slice(0, FINGERPRINT_OUTPUT_MAX_CHARS) : s;
}

function isJsonParsable(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

export function extractFeatures(outputs: ProbeOutput[]): ProbeFeature[] {
  return outputs.map((o) => {
    const text = truncateOutput(o.output ?? '');
    return {
      probeId: o.probeId,
      length: text.length,
      refused: isRefusal(text),
      jsonParsable: isJsonParsable(text),
      text,
    };
  });
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function charTrigrams(s: string): Set<string> {
  const chars = Array.from(normalize(s));
  const out = new Set<string>();
  if (chars.length === 0) return out;
  if (chars.length < 3) {
    out.add(chars.join(''));
    return out;
  }
  for (let i = 0; i <= chars.length - 3; i++) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

export function trigramJaccard(a: string, b: string): number {
  const sa = charTrigrams(a);
  const sb = charTrigrams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

function lengthRatio(a: number, b: number): number {
  const mx = Math.max(a, b);
  return mx === 0 ? 1 : Math.min(a, b) / mx;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export function compareFingerprints(
  a: ProbeFeature[],
  b: ProbeFeature[],
  opts: { weights?: Partial<FingerprintWeights>; threshold?: number; identityProbeId?: string } = {},
): FingerprintComparison {
  const weights: FingerprintWeights = { ...DEFAULT_FINGERPRINT_WEIGHTS, ...(opts.weights ?? {}) };
  const threshold = opts.threshold ?? DEFAULT_FINGERPRINT_THRESHOLD;
  const identityId =
    opts.identityProbeId ?? FINGERPRINT_PROBES_V1.find((p) => p.kind === 'identity')!.id;
  const bMap = new Map(b.map((f) => [f.probeId, f]));
  const pairs = a.filter((f) => bMap.has(f.probeId)).map((f) => [f, bMap.get(f.probeId)!] as const);

  const ngram = mean(pairs.map(([x, y]) => trigramJaccard(x.text, y.text)));
  const length = mean(pairs.map(([x, y]) => lengthRatio(x.length, y.length)));
  const refusal = mean(pairs.map(([x, y]) => (x.refused === y.refused ? 1 : 0)));
  const format = mean(pairs.map(([x, y]) => (x.jsonParsable === y.jsonParsable ? 1 : 0)));
  const idPair = pairs.find(([x]) => x.probeId === identityId);
  const identity = idPair ? trigramJaccard(idPair[0].text, idPair[1].text) : 0;

  const wSum = weights.ngram + weights.length + weights.refusal + weights.format + weights.identity;
  const raw =
    wSum <= 0
      ? 0
      : (weights.ngram * ngram +
          weights.length * length +
          weights.refusal * refusal +
          weights.format * format +
          weights.identity * identity) /
        wSum;
  const similarity = pairs.length === 0 ? 0 : round4(Math.min(1, Math.max(0, raw)));
  return {
    similarity,
    threshold,
    drift: similarity < threshold,
    components: {
      ngram: round4(ngram),
      length: round4(length),
      refusal: round4(refusal),
      format: round4(format),
      identity: round4(identity),
    },
    weights,
    comparedProbes: pairs.length,
  };
}
