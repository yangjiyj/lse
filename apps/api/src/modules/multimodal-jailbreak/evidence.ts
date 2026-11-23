import { MULTIMODAL_ENGINE } from './executor.js';

export interface MultimodalEvidenceSummary {
  attackType: string;
  attackLabel: string;
  seed: string;
  text: string;
  imageText: string;
  injectedText: string | null;
  image: { mimeType: string; width: number; height: number; sha256: string };
  judge: {
    engine: string;
    status: string;
    verdict: string;
    severity: string | null;
    score: number | null;
    evidence: string | null;
  } | null;
  /** 客户自带图片集题目的补充信息；程序生成题为 null。 */
  byo: { category: string; expected: string; note: string; imageName: string } | null;
  error: string | null;
}

interface RunLike {
  engine: string;
  rawOutput: string | null;
}

function parse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 结果列表用：只返回证据元数据与 sha256，不内联 base64（图片经单独接口获取）。 */
export function summarizeMultimodalEvidence(
  runs: readonly RunLike[],
): MultimodalEvidenceSummary | null {
  const run = runs.find((r) => r.engine === MULTIMODAL_ENGINE);
  const raw = parse(run?.rawOutput ?? null);
  if (!raw) return null;
  const image =
    raw.image && typeof raw.image === 'object' ? (raw.image as Record<string, unknown>) : {};
  const judge =
    raw.judge && typeof raw.judge === 'object' ? (raw.judge as Record<string, unknown>) : null;
  return {
    attackType: str(raw.attackType) ?? '',
    attackLabel: str(raw.attackLabel) ?? '',
    seed: str(raw.seed) ?? '',
    text: str(raw.text) ?? '',
    imageText: str(raw.imageText) ?? '',
    injectedText: str(raw.injectedText),
    image: {
      mimeType: str(image.mimeType) ?? 'image/png',
      width: typeof image.width === 'number' ? image.width : 0,
      height: typeof image.height === 'number' ? image.height : 0,
      sha256: str(image.sha256) ?? '',
    },
    judge: judge
      ? {
          engine: str(judge.engine) ?? '',
          status: str(judge.status) ?? '',
          verdict: str(judge.verdict) ?? 'UNKNOWN',
          severity: str(judge.severity),
          score: typeof judge.score === 'number' ? judge.score : null,
          evidence: str(judge.evidence),
        }
      : null,
    byo:
      raw.byo && typeof raw.byo === 'object'
        ? {
            category: str((raw.byo as Record<string, unknown>).category) ?? '',
            expected: str((raw.byo as Record<string, unknown>).expected) ?? '',
            note: str((raw.byo as Record<string, unknown>).note) ?? '',
            imageName: str((raw.byo as Record<string, unknown>).imageName) ?? '',
          }
        : null,
    error: str(raw.error),
  };
}

/** 自带图片题的存证引用：字节只在图片集内，证据保存 imageId 与 sha256。 */
export function extractByoImageRef(
  runs: readonly RunLike[],
): { imageId: string; sha256: string; mimeType: string } | null {
  const run = runs.find((r) => r.engine === MULTIMODAL_ENGINE);
  const raw = parse(run?.rawOutput ?? null);
  const image =
    raw?.image && typeof raw.image === 'object' ? (raw.image as Record<string, unknown>) : null;
  const imageId = str(image?.byoImageId);
  if (!image || !imageId) return null;
  return { imageId, sha256: str(image.sha256) ?? '', mimeType: str(image.mimeType) ?? 'image/png' };
}

/** 图片接口用：取出存证 PNG 字节与 sha256。 */
export function extractMultimodalImage(
  runs: readonly RunLike[],
): { png: Buffer; sha256: string } | null {
  const run = runs.find((r) => r.engine === MULTIMODAL_ENGINE);
  const raw = parse(run?.rawOutput ?? null);
  const image =
    raw?.image && typeof raw.image === 'object' ? (raw.image as Record<string, unknown>) : null;
  const b64 = str(image?.base64);
  if (!image || !b64) return null;
  return { png: Buffer.from(b64, 'base64'), sha256: str(image.sha256) ?? '' };
}
