import { Cursor, type ByteSource } from './source.js';
import type { ModelFinding, FormatScan } from './types.js';

const T = {
  U8: 0,
  I8: 1,
  U16: 2,
  I16: 3,
  U32: 4,
  I32: 5,
  F32: 6,
  BOOL: 7,
  STR: 8,
  ARR: 9,
  U64: 10,
  I64: 11,
  F64: 12,
};
const FIXED: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};
const MAX_KV = 100_000;
const MAX_TENSORS = 1_000_000;
const MAX_KEEP_STR = 1024 * 1024;
const KEEP_KEYS =
  /^(?:tokenizer\.chat_template(?:\..+)?|general\.(?:name|architecture|license|size_label|source\.url|basename|version|file_type|type|finetune|quantization_version|base_model\.(?:count|0\.(?:name|organization|repo_url)))|adapter\.(?:type|lora\.alpha)|[a-z0-9_]+\.context_length)$/;

// Jinja 沙箱逃逸（SSTI）：只匹配真正的逃逸链。namespace/cycler/joiner 是 Jinja 合法内置，
// 真实模板（Qwen2.5、Llama3.1 等）大量使用，单独出现不告警；与 __globals__ 等组合时由下列规则命中。
const TEMPLATE_SSTI =
  /__(?:class|mro|subclasses|globals|builtins|import|base|bases|getattribute|code|func|self|reduce|reduce_ex|init_subclass)__|\battr\s*\(\s*['"](?:_|\\x5f|\\u005f)|\|\s*attr\s*\(\s*[^)]*\)\s*\|\s*attr\b|\bself\._TemplateReference__context\b|\brequest\.application\b|\b(?:os|subprocess)\s*\.\s*(?:popen|system|exec\w*|spawn\w*|Popen|call|run|check_output)\b|\b(?:importlib|__import__)\b|\\x5f\\x5f/;
const TEMPLATE_INJECTION =
  /ignore (?:all )?(?:previous|prior|above) (?:instructions|rules)|disregard (?:the )?(?:system|previous)|you are now (?:dan|in developer mode)|忽略.{0,8}(?:之前|以上|先前|系统).{0,8}(?:指令|规则|提示)|无视.{0,6}(?:规则|限制)/i;
const TEMPLATE_URL = /https?:\/\/[^\s'"}]+/i;

export function checkChatTemplate(key: string, tpl: string): ModelFinding[] {
  const out: ModelFinding[] = [];
  const ssti = TEMPLATE_SSTI.exec(tpl);
  if (ssti)
    out.push({
      ruleId: 'GGUF_TEMPLATE_SSTI',
      severity: 'HIGH',
      title: 'chat_template 含模板沙箱逃逸特征',
      detail: `${key} 命中 “${ssti[0]}”`,
    });
  const inj = TEMPLATE_INJECTION.exec(tpl);
  if (inj)
    out.push({
      ruleId: 'GGUF_TEMPLATE_INJECTION',
      severity: 'MEDIUM',
      title: 'chat_template 含可疑注入指令',
      detail: `${key} 命中 “${inj[0].slice(0, 120)}”`,
    });
  const url = TEMPLATE_URL.exec(tpl);
  if (url)
    out.push({
      ruleId: 'GGUF_TEMPLATE_URL',
      severity: 'INFO',
      title: 'chat_template 含外部链接',
      detail: `${key} 含 “${url[0].slice(0, 200)}”，模板渲染不会访问该地址，供人工知悉`,
    });
  return out;
}

async function gstr(cur: Cursor, keep: boolean): Promise<string | null> {
  const n = await cur.u64();
  if (!keep || n > MAX_KEEP_STR) {
    await cur.skip(n);
    return null;
  }
  return (await cur.take(n)).toString('utf8');
}

async function skipValue(cur: Cursor, type: number, depth = 0): Promise<void> {
  if (FIXED[type] !== undefined) return cur.skip(FIXED[type]!);
  if (type === T.STR) {
    await cur.skip(await cur.u64());
    return;
  }
  if (type === T.ARR) {
    if (depth > 4) throw new Error('GGUF 数组嵌套过深');
    const et = await cur.u32(),
      len = await cur.u64();
    if (FIXED[et] !== undefined) return cur.skip(FIXED[et]! * len);
    for (let i = 0; i < len; i++) await skipValue(cur, et, depth + 1);
    return;
  }
  throw new Error(`未知 GGUF 值类型 ${type}`);
}

async function readScalar(cur: Cursor, type: number): Promise<string | number | boolean | null> {
  switch (type) {
    case T.U8:
      return await cur.byte();
    case T.I8:
      return (await cur.take(1)).readInt8(0);
    case T.U16:
      return (await cur.take(2)).readUInt16LE(0);
    case T.I16:
      return (await cur.take(2)).readInt16LE(0);
    case T.U32:
      return await cur.u32();
    case T.I32:
      return await cur.i32();
    case T.F32:
      return (await cur.take(4)).readFloatLE(0);
    case T.BOOL:
      return (await cur.byte()) !== 0;
    case T.U64:
      return Number((await cur.take(8)).readBigUInt64LE(0));
    case T.I64:
      return Number((await cur.take(8)).readBigInt64LE(0));
    case T.F64:
      return (await cur.take(8)).readDoubleLE(0);
    default:
      await skipValue(cur, type);
      return null;
  }
}

/** 流式解析 GGUF v2/v3 头部：KV 元数据与张量信息表，不读取张量数据。 */
export async function scanGguf(src: ByteSource): Promise<FormatScan> {
  const cur = new Cursor(src);
  const findings: ModelFinding[] = [];
  const meta: Record<string, unknown> = {};
  try {
    if ((await cur.take(4)).toString('latin1') !== 'GGUF') throw new Error('缺少 GGUF 魔数');
    const version = await cur.u32();
    if (version < 2 || version > 3) {
      return {
        format: 'gguf',
        findings: [
          {
            ruleId: 'GGUF_VERSION_LIMITED',
            severity: 'MEDIUM',
            title: 'GGUF 版本不受支持',
            detail: `版本 ${version} 未解析，仅支持 v2/v3`,
          },
        ],
        meta,
      };
    }
    const tensorCount = await cur.u64(),
      kvCount = await cur.u64();
    if (kvCount > MAX_KV || tensorCount > MAX_TENSORS) throw new Error('KV 或张量数量超过上限');
    meta.ggufVersion = version;
    meta.tensorCount = tensorCount;
    for (let i = 0; i < kvCount; i++) {
      const key = (await gstr(cur, true)) ?? '';
      const type = await cur.u32();
      const keep = KEEP_KEYS.test(key);
      if (type === T.STR) {
        const v = await gstr(cur, keep);
        if (v === null && keep && key.startsWith('tokenizer.chat_template')) {
          findings.push({
            ruleId: 'GGUF_TEMPLATE_OVERSIZE',
            severity: 'MEDIUM',
            title: 'chat_template 超长未检查',
            detail: `${key} 超过 1MiB`,
          });
        }
        if (v !== null) {
          if (key.startsWith('tokenizer.chat_template'))
            findings.push(...checkChatTemplate(key, v));
          else meta[key] = v;
        }
      } else if (keep && type !== T.ARR) meta[key] = await readScalar(cur, type);
      else await skipValue(cur, type);
    }
    let params = 0;
    for (let i = 0; i < tensorCount; i++) {
      await gstr(cur, false);
      const nd = await cur.u32();
      if (nd > 8) throw new Error('张量维度数异常');
      let n = 1;
      for (let d = 0; d < nd; d++) n *= await cur.u64();
      await cur.skip(12); // type u32 + offset u64
      params += n;
    }
    meta.parameterCount = params;
    findings.push({
      ruleId: 'GGUF_PARSED',
      severity: 'INFO',
      title: 'GGUF 元数据解析完成',
      detail: `${kvCount} 个元数据项，${tensorCount} 个张量`,
    });
  } catch (e) {
    findings.push({
      ruleId: 'GGUF_PARSE_ABORTED',
      severity: 'MEDIUM',
      title: 'GGUF 解析中止',
      detail: `解析中止：${e instanceof Error ? e.message : '未知错误'}`,
    });
  }
  return { format: 'gguf', findings, meta };
}
