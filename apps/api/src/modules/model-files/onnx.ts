import { Cursor, type ByteSource } from './source.js';
import type { FormatScan, ModelFinding } from './types.js';

const STANDARD_DOMAINS = new Set([
  '',
  'ai.onnx',
  'ai.onnx.ml',
  'ai.onnx.training',
  'ai.onnx.preview.training',
]);
const MAX_DEPTH = 16;
const MAX_NODES = 5_000_000;

async function varint(cur: Cursor): Promise<number> {
  let v = 0,
    mul = 1;
  for (let i = 0; i < 10; i++) {
    const b = await cur.byte();
    v += (b & 0x7f) * mul;
    if (!(b & 0x80)) {
      if (!Number.isSafeInteger(v)) throw new Error('varint 超出范围');
      return v;
    }
    mul *= 128;
  }
  throw new Error('varint 过长');
}

type FieldFn = (field: number, len: number, end: number) => Promise<boolean>;

/** 遍历 [cur.pos,end) 内的 protobuf 字段；handler 返回 true 表示已消费该长度字段。 */
async function walk(cur: Cursor, end: number, onLen: FieldFn): Promise<void> {
  while (cur.pos < end) {
    const key = await varint(cur);
    const field = Math.floor(key / 8),
      wire = key & 7;
    if (wire === 0) await varint(cur);
    else if (wire === 1) await cur.skip(8);
    else if (wire === 5) await cur.skip(4);
    else if (wire === 2) {
      const len = await varint(cur);
      const stop = cur.pos + len;
      if (stop > end) throw new Error('protobuf 长度字段越界');
      if (!(await onLen(field, len, stop))) await cur.skip(len);
      if (cur.pos !== stop) throw new Error('protobuf 子消息长度不一致');
    } else throw new Error(`protobuf 未知 wire type ${wire}`);
  }
}

async function text(cur: Cursor, len: number): Promise<string> {
  if (len > 4096) {
    await cur.skip(len);
    return '';
  }
  return (await cur.take(len)).toString('utf8');
}

/** 流式解析 ONNX ModelProto：算子域、自定义函数、外部数据路径；跳过张量原始数据。 */
export async function scanOnnx(src: ByteSource): Promise<FormatScan> {
  const cur = new Cursor(src);
  const findings: ModelFinding[] = [];
  const customOps = new Set<string>();
  const opsetDomains = new Set<string>();
  const externalPaths = new Set<string>();
  const functions = new Set<string>();
  const meta: Record<string, unknown> = {};
  let nodes = 0;

  const extEntry = async (end: number): Promise<void> => {
    let key = '',
      value = '';
    await walk(cur, end, async (f, len) => {
      if (f === 1) {
        key = await text(cur, len);
        return true;
      }
      if (f === 2) {
        value = await text(cur, len);
        return true;
      }
      return false;
    });
    if (key === 'location') externalPaths.add(value);
  };
  const tensorProto = async (end: number) =>
    walk(cur, end, async (f, _len, stop) => {
      if (f === 13) {
        await extEntry(stop);
        return true;
      }
      return false;
    });

  const graph = async (end: number, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error('子图嵌套过深');
    await walk(cur, end, async (f, _len, stop) => {
      if (f === 1) {
        await node(stop, depth);
        return true;
      } // node
      if (f === 5) {
        await tensorProto(stop);
        return true;
      } // initializer
      return false;
    });
  };
  const attribute = async (end: number, depth: number) =>
    walk(cur, end, async (f, _len, stop) => {
      if (f === 5) {
        await tensorProto(stop);
        return true;
      } // t
      if (f === 6 || f === 11) {
        await graph(stop, depth + 1);
        return true;
      } // g / graphs
      return false;
    });
  const node = async (end: number, depth: number): Promise<void> => {
    if (++nodes > MAX_NODES) throw new Error('节点数超过上限');
    let op = '',
      domain = '';
    await walk(cur, end, async (f, len, stop) => {
      if (f === 4) {
        op = await text(cur, len);
        return true;
      }
      if (f === 7) {
        domain = await text(cur, len);
        return true;
      }
      if (f === 5) {
        await attribute(stop, depth);
        return true;
      }
      return false;
    });
    if (!STANDARD_DOMAINS.has(domain)) customOps.add(`${domain}::${op}`);
  };

  try {
    await walk(cur, src.size, async (f, len, stop) => {
      if (f === 7) {
        await graph(stop, 0);
        return true;
      }
      if (f === 2 || f === 3) {
        meta[f === 2 ? 'producer' : 'producerVersion'] = await text(cur, len);
        return true;
      }
      if (f === 8) {
        await walk(cur, stop, async (g, l) => {
          if (g === 1) {
            opsetDomains.add(await text(cur, l));
            return true;
          }
          return false;
        });
        return true;
      }
      if (f === 25) {
        await walk(cur, stop, async (g, l) => {
          if (g === 1) {
            functions.add(await text(cur, l));
            return true;
          }
          return false;
        });
        return true;
      }
      return false;
    });
    meta.nodeCount = nodes;
    meta.opsetDomains = [...opsetDomains];
    if (customOps.size)
      findings.push({
        ruleId: 'ONNX_CUSTOM_OP',
        severity: 'MEDIUM',
        title: 'ONNX 使用非标准域自定义算子',
        detail: `需加载外部算子库：${[...customOps].slice(0, 20).join('、')}`,
      });
    if (functions.size)
      findings.push({
        ruleId: 'ONNX_MODEL_FUNCTION',
        severity: 'LOW',
        title: 'ONNX 定义模型内函数',
        detail: [...functions].slice(0, 20).join('、'),
      });
    for (const p of externalPaths) {
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')) {
        findings.push({
          ruleId: 'ONNX_EXTERNAL_DATA_TRAVERSAL',
          severity: 'HIGH',
          title: 'ONNX 外部数据路径越出模型目录',
          detail: `location=${p}`,
        });
      }
    }
    findings.push({
      ruleId: 'ONNX_PARSED',
      severity: 'INFO',
      title: 'ONNX 结构解析完成',
      detail: `${nodes} 个节点，${externalPaths.size} 个外部数据引用`,
    });
  } catch (e) {
    findings.push({
      ruleId: 'ONNX_PARSE_ABORTED',
      severity: 'MEDIUM',
      title: 'ONNX 解析中止',
      detail: `解析中止：${e instanceof Error ? e.message : '未知错误'}`,
    });
  }
  return { format: 'onnx', findings, meta };
}
