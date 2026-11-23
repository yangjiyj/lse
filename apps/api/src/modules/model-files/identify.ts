import {
  UNQUANTIZED_TYPES,
  applyKnownModels,
  knownModelIndex,
  quantizationFromFileName,
  type KnownModelIdentity,
  type KnownModelIndex,
} from './known-models.js';
import type { FormatScan } from './types.js';

/**
 * 模型识别：先按 sha256 查已知模型库，查不到再按元数据判断。
 * - GGUF：general.name、general.architecture、general.file_type（量化类型）；
 * - safetensors 等加同目录 config.json：architectures、model_type、torch_dtype、quantization_config.quant_method；
 * - 同目录 adapter_config.json：LoRA/PEFT 适配器的 r、lora_alpha、target_modules、base_model_name_or_path；
 * - 同目录 mergekit 配置 → 合并；training_args.bin → 微调。
 * 结论「原始」只来自已知库：官方基座、官方指令版（显示「原始（官方指令版）」）、与官方一致的转存、
 * 量化仓库里的 F16/BF16/F32（「原始（格式转换）」）、转存方重新保存的版本（「原始（重新保存版）」）；
 * 社区仓库的指令版是在官方模型上继续训练的，算「微调（全参）」。
 * 查不到、也没有量化/适配器/合并/训练痕迹的，结论为「未识别」。
 */
export const MODEL_VERDICTS = [
  'original',
  'quantized',
  'finetuned',
  'adapter',
  'merged',
  'unidentified',
] as const;
export type ModelVerdict = (typeof MODEL_VERDICTS)[number];
export const MODEL_VERDICT_LABELS: Record<ModelVerdict, string> = {
  original: '原始',
  quantized: '量化',
  finetuned: '微调（全参）',
  adapter: '适配器（LoRA/PEFT）',
  merged: '合并',
  unidentified: '未识别',
};

/** 已知库命中时的结论和显示文字。 */
function verdictOfKnown(k: KnownModelIdentity): { verdict: ModelVerdict; label: string } {
  if (k.kind === 'lora') return { verdict: 'adapter', label: MODEL_VERDICT_LABELS.adapter };
  if (k.kind === 'merged') return { verdict: 'merged', label: MODEL_VERDICT_LABELS.merged };
  if (k.kind === 'quantized')
    return k.quantization && UNQUANTIZED_TYPES.has(k.quantization)
      ? { verdict: 'original', label: '原始（格式转换）' }
      : { verdict: 'quantized', label: MODEL_VERDICT_LABELS.quantized };
  if (k.copyOf)
    return {
      verdict: 'original',
      label: k.copyOf.resaved ? '原始（重新保存版）' : '原始（转存版）',
    };
  if (k.official)
    return { verdict: 'original', label: k.kind === 'instruct' ? '原始（官方指令版）' : '原始' };
  return { verdict: 'finetuned', label: MODEL_VERDICT_LABELS.finetuned };
}

export interface ModelIdentification {
  verdict: ModelVerdict;
  /** 结论的显示文字，可能带说明，如「原始（官方指令版）」 */
  verdictLabel: string;
  name?: string;
  architecture?: string;
  modelType?: string;
  /** 量化类型或方法，如 Q4_K_M、AWQ 4bit、FP8 */
  quantization?: string;
  dtype?: string;
  baseModel?: string;
  lora?: { peftType?: string; r?: number; alpha?: number; targetModules?: string[] };
  /** 判断依据（中文短句），页面悬浮提示用 */
  basis: string[];
}

type ScannedLike = FormatScan & { path: string; sha256: string };

const WEIGHT_FORMATS = new Set([
  'pickle',
  'pytorch-zip',
  'safetensors',
  'gguf',
  'onnx',
  'keras',
  'keras-h5',
]);
/** 训练过程的产物，不是模型权重。 */
const TRAINING_ARTIFACT =
  /(?:^|[\\/])(?:training_args|optimizer|scheduler|rng_state[^\\/]*)\.(?:bin|pt|pth)$/i;

export function isModelWeight(f: { path: string; format: string }): boolean {
  return WEIGHT_FORMATS.has(f.format) && !TRAINING_ARTIFACT.test(f.path);
}

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? p).toLowerCase();
const dirOf = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** llama.cpp 的 LLAMA_FTYPE 编号 → 名称。 */
const GGUF_FILE_TYPES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  33: 'Q4_0_4_4',
  34: 'Q4_0_4_8',
  35: 'Q4_0_8_8',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'MXFP4_MOE',
};
const UNQUANTIZED = UNQUANTIZED_TYPES;

const QUANT_METHOD_LABELS: Record<string, string> = {
  gptq: 'GPTQ',
  awq: 'AWQ',
  bitsandbytes: 'bitsandbytes',
  fp8: 'FP8',
  'compressed-tensors': 'compressed-tensors',
  hqq: 'HQQ',
  eetq: 'EETQ',
  aqlm: 'AQLM',
  exl2: 'EXL2',
  gguf: 'GGUF',
};

function quantLabel(q: Record<string, unknown>): string | undefined {
  const method = str(q.method);
  const bits = num(q.bits) ?? (q.loadIn4bit ? 4 : q.loadIn8bit ? 8 : undefined);
  const label = method
    ? (QUANT_METHOD_LABELS[method.toLowerCase()] ?? method)
    : bits
      ? 'bitsandbytes'
      : undefined;
  if (!label) return undefined;
  return bits && label !== 'FP8' ? `${label} ${bits}bit` : label;
}

interface DirContext {
  modelConfig?: Record<string, unknown>;
  adapterConfig?: Record<string, unknown>;
  mergekit: boolean;
  trainingArgs: boolean;
}

function dirContexts(files: ScannedLike[]): Map<string, DirContext> {
  const out = new Map<string, DirContext>();
  for (const f of files) {
    const d = dirOf(f.path);
    const ctx = out.get(d) ?? { mergekit: false, trainingArgs: false };
    const name = baseName(f.path);
    if (f.format === 'config') {
      if (name === 'config.json' && f.meta.modelConfig)
        ctx.modelConfig = f.meta.modelConfig as Record<string, unknown>;
      if (name === 'adapter_config.json' && f.meta.adapterConfig)
        ctx.adapterConfig = f.meta.adapterConfig as Record<string, unknown>;
      if (f.meta.mergekit === true) ctx.mergekit = true;
    }
    if (name === 'training_args.bin') ctx.trainingArgs = true;
    out.set(d, ctx);
  }
  return out;
}

function identifyOne(
  f: ScannedLike,
  ctx: DirContext,
  known: KnownModelIdentity | null,
): ModelIdentification {
  const m = f.meta;
  const basis: string[] = [];
  const out: Omit<ModelIdentification, 'verdict' | 'verdictLabel' | 'basis'> = {};
  let verdict: ModelVerdict | undefined;
  let quantized = false;
  let adapter = false;
  let baseFromConfigPath = false;

  if (f.format === 'gguf') {
    out.name = str(m['general.name']);
    out.architecture = str(m['general.architecture']);
    const ft = num(m['general.file_type']);
    const typeName = ft !== undefined ? GGUF_FILE_TYPES[ft] : undefined;
    if (typeName) {
      basis.push(`GGUF general.file_type=${ft}（${typeName}）`);
      if (UNQUANTIZED.has(typeName)) out.dtype = typeName;
      else {
        out.quantization = typeName;
        quantized = true;
      }
    } else {
      const fromName = quantizationFromFileName(f.path);
      if (fromName && !UNQUANTIZED.has(fromName)) {
        out.quantization = fromName;
        quantized = true;
        basis.push(`文件名含量化类型 ${fromName}`);
      } else if (fromName) out.dtype = fromName;
    }
    if (m['general.type'] === 'adapter' || str(m['adapter.type'])) {
      adapter = true;
      out.lora = {
        peftType: str(m['adapter.type'])?.toUpperCase() ?? 'LORA',
        alpha: num(m['adapter.lora.alpha']),
      };
      basis.push('GGUF general.type=adapter');
    }
    const bOrg = str(m['general.base_model.0.organization']);
    const bName = str(m['general.base_model.0.name']);
    if (bName) out.baseModel = bOrg ? `${bOrg}/${bName}` : bName;
  }

  const cfg = ctx.modelConfig;
  if (cfg && f.format !== 'gguf') {
    const archs = cfg.architectures as string[] | undefined;
    out.architecture ??= archs?.[0];
    out.modelType = str(cfg.modelType);
    out.dtype ??= str(cfg.torchDtype);
    const q = cfg.quantization as Record<string, unknown> | undefined;
    const ql = q ? quantLabel(q) : undefined;
    if (ql) {
      out.quantization = ql;
      quantized = true;
      basis.push(`config.json quantization_config.quant_method=${str(q!.method) ?? '未写'}`);
    }
    // _name_or_path 是保存时加载的来源；只在确有改动（微调、合并、量化）时才当作基座
    const nameOrPath = str(cfg.nameOrPath);
    if (
      nameOrPath &&
      !nameOrPath.startsWith('/') &&
      !nameOrPath.startsWith('.') &&
      !out.baseModel
    ) {
      out.baseModel = nameOrPath;
      baseFromConfigPath = true;
    }
  }
  if (f.format === 'safetensors' && !quantized) {
    const dtypes = (m.dtypes as string[] | undefined) ?? [];
    if ((num(m.packedQuantTensors) ?? 0) > 0) {
      quantized = true;
      out.quantization ??= 'GPTQ/AWQ';
      basis.push('safetensors 含 qweight/qzeros 打包张量');
    } else if (dtypes.some((d) => d.startsWith('F8_'))) {
      // FP8 量化只把线性层权重存成 F8，归一化、嵌入和缩放因子仍是 BF16/F32
      quantized = true;
      out.quantization ??= 'FP8';
      basis.push(
        `safetensors 含有 F8 类型的权重张量（${dtypes.filter((d) => d.startsWith('F8_')).join('、')}）`,
      );
    }
  }

  const ad = ctx.adapterConfig;
  if (ad && (f.format !== 'gguf' || adapter)) {
    adapter = true;
    out.lora = {
      peftType: str(ad.peftType),
      r: num(ad.r),
      alpha: num(ad.loraAlpha),
      targetModules: ad.targetModules as string[] | undefined,
    };
    out.baseModel = str(ad.baseModel) ?? out.baseModel;
    basis.push(`adapter_config.json peft_type=${str(ad.peftType) ?? '未写'}`);
  } else if (f.format === 'safetensors' && (num(m.loraTensors) ?? 0) > 0) {
    adapter = true;
    basis.push('safetensors 含 lora_A/lora_B 张量');
  }
  if (out.lora)
    out.lora = Object.fromEntries(Object.entries(out.lora).filter(([, v]) => v !== undefined));

  let verdictLabel: string | undefined;
  if (known) {
    const v = verdictOfKnown(known);
    verdict = v.verdict;
    verdictLabel = v.label;
    basis.unshift(
      `sha256 命中已知模型库：${known.repo}` +
        (known.verifiedVia ? `（哈希经 ${known.verifiedVia} 核对）` : '') +
        (known.previous ? `，官方旧版本 ${known.previous.revision.slice(0, 12)}` : ''),
    );
    if (known.quantization && UNQUANTIZED.has(known.quantization)) {
      out.dtype ??= known.quantization;
      delete out.quantization;
    } else out.quantization = known.quantization ?? out.quantization;
    out.baseModel = known.baseModel ?? out.baseModel;
    out.name ??= known.name;
  } else if (adapter) verdict = 'adapter';
  else if (quantized) verdict = 'quantized';
  else if (ctx.mergekit) {
    verdict = 'merged';
    basis.push('同目录有 mergekit 合并配置');
  } else if (ctx.trainingArgs) {
    verdict = 'finetuned';
    basis.push('同目录有 training_args.bin（训练产物）');
  } else if (f.format === 'gguf' && num(m['general.base_model.count'])) {
    verdict = 'finetuned';
    basis.push('GGUF 记录了基座模型（general.base_model）');
  } else verdict = 'unidentified';
  if (verdict === 'unidentified' && baseFromConfigPath) delete out.baseModel;
  if (!basis.length) basis.push('未在已知模型库中，也未发现量化、适配器、合并或训练痕迹');

  const result: ModelIdentification = {
    verdict,
    verdictLabel: verdictLabel ?? MODEL_VERDICT_LABELS[verdict],
    ...out,
    basis,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => v !== undefined),
  ) as unknown as ModelIdentification;
}

/**
 * 给模型权重文件补上识别结果（meta.identification）和已知模型匹配（meta.knownModel、knownModelLabel），
 * 不一致的追加高危问题。配置文件、脚本和训练产物不出结论。root 为目录扫描的根，上传扫描传空串。
 */
export function identifyModels<T extends ScannedLike>(
  files: T[],
  root: string,
  index: KnownModelIndex = knownModelIndex(),
): T[] {
  const weights = files.filter(isModelWeight);
  const annotated = applyKnownModels(weights, root, index);
  const byOriginal = new Map(weights.map((f, i) => [f, annotated[i]!]));
  const ctx = dirContexts(files);
  return files.map((f) => {
    const w = byOriginal.get(f);
    if (!w) return f;
    const known = (w.meta.knownModel as KnownModelIdentity | null) ?? null;
    const identification = identifyOne(
      w,
      ctx.get(dirOf(f.path)) ?? { mergekit: false, trainingArgs: false },
      known,
    );
    return { ...w, meta: { ...w.meta, identification } };
  });
}
