import { Cursor, TruncatedError, type ByteSource } from './source.js';
import { classifyGlobal, type GlobalClass } from './pickle-rules.js';

/**
 * Pickle 静态分析：逐个 opcode 解析并模拟栈/memo，只追踪字符串与全局引用。
 * 绝不反序列化，不执行任何对象构造。
 */
export type PickleSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export interface PickleIssue {
  ruleId: string;
  severity: PickleSeverity;
  title: string;
  detail: string;
}
export interface PickleReport {
  globals: string[];
  issues: PickleIssue[];
  opcodeCount: number;
  complete: boolean;
}

type Val =
  | { k: 'mark' }
  | { k: 'str'; v: string }
  | { k: 'global'; v: string; cls: GlobalClass }
  | { k: 'other' };
const OTHER: Val = { k: 'other' };
const MARK: Val = { k: 'mark' };
const MAX_STR = 4096;
const MAX_STACK = 1_000_000;
const MAX_OPCODES = 50_000_000;

export { classifyGlobal };

/** 单个 pickle 段（一次 load 的载荷）内收集的危险证据；一段只产出一条高危。 */
interface Segment {
  dangerous: Map<string, Set<string>>;
  unsafeCalls: Set<string>;
}
const newSegment = (): Segment => ({ dangerous: new Map(), unsafeCalls: new Set() });

function unquote(line: string): string {
  const s = line.trim();
  const q = s[0];
  if ((q === "'" || q === '"') && s.endsWith(q) && s.length >= 2) {
    return s
      .slice(1, -1)
      .replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e: string) =>
        e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === 'n' ? '\n' : e,
      );
  }
  return s;
}

function rawUnicode(line: string): string {
  return line.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_, a?: string, b?: string) =>
    String.fromCodePoint(parseInt((a ?? b)!, 16)),
  );
}

export interface AnalyzeOptions {
  /** 实际读取的 opcode 字节上限（跳过的大段字节串不计入）；超出后停止并标注“部分分析”。 */
  maxReadBytes?: number;
}

class WindowError extends Error {}

const list = (s: Iterable<string>, n = 12) => {
  const a = [...s];
  return a.slice(0, n).join('、') + (a.length > n ? ` 等 ${a.length} 项` : '');
};

/**
 * 解析 src 的 [start,end) 区间。依次解析首尾相连的多个 pickle（PyTorch 旧格式 torch.load
 * 会连续加载 5 段），直到区间结束；后续段首个 opcode 即非法时视为尾随的原始张量数据。
 */
export async function analyzePickle(
  src: ByteSource,
  start = 0,
  end = src.size,
  opts: AnalyzeOptions = {},
): Promise<PickleReport> {
  const cur = new Cursor(src, start, end);
  const globals = new Set<string>();
  const issues: PickleIssue[] = [];
  let opcodeCount = 0;
  let complete = false;
  let seg = newSegment();
  const unknown = new Set<string>();
  const calledUnknown = new Set<string>();
  const common = new Set<string>();
  const window = opts.maxReadBytes ?? Number.POSITIVE_INFINITY;
  const issue = (i: PickleIssue) => {
    if (issues.length < 200) issues.push(i);
  };
  const addGlobal = (module: string, name: string, via: string): Val => {
    const full = `${module}.${name}`;
    globals.add(full);
    const cls = classifyGlobal(module, name);
    if (cls === 'dangerous') {
      if (!seg.dangerous.has(full)) seg.dangerous.set(full, new Set([`${via} 引用`]));
    } else if (cls === 'unknown') unknown.add(full);
    else if (cls === 'common') common.add(full);
    return { k: 'global', v: full, cls };
  };
  const onCall = (callee: Val, op: string) => {
    if (callee.k !== 'global') return;
    if (callee.cls === 'dangerous') seg.dangerous.get(callee.v)?.add(`${op} 调用`);
    else if (callee.cls === 'unknown') {
      seg.unsafeCalls.add(`${op} ${callee.v}`);
      calledUnknown.add(callee.v);
    }
  };
  let segNo = 0;
  const flush = () => {
    const where = segNo > 1 ? `第 ${segNo} 段 pickle：` : '';
    if (seg.dangerous.size) {
      const parts = [...seg.dangerous].map(([g, how]) => `${g}（${[...how].join('、')}）`);
      issue({
        ruleId: 'PICKLE_DANGEROUS_GLOBAL',
        severity: 'HIGH',
        title: 'Pickle 加载时可执行危险对象',
        detail: `${where}${list(parts)}${seg.unsafeCalls.size ? `；另调用非白名单对象 ${list(seg.unsafeCalls)}` : ''}`,
      });
    } else if (seg.unsafeCalls.size) {
      issue({
        ruleId: 'PICKLE_UNSAFE_CALL',
        severity: 'HIGH',
        title: 'Pickle 加载时调用非白名单对象',
        detail: `${where}${list(seg.unsafeCalls)}（加载即执行，未在安全名单内）`,
      });
    }
    seg = newSegment();
  };
  const tick = () => {
    if (cur.pos - start - cur.skipped > window) throw new WindowError();
    if (++opcodeCount > MAX_OPCODES) throw new Error('opcode 数量超过上限');
    return opcodeCount;
  };

  try {
    while (cur.remaining > 0) {
      segNo++;
      const segStart = cur.pos;
      try {
        await parseOne(cur, addGlobal, onCall, issue, tick);
        flush();
        complete = true;
      } catch (e) {
        flush();
        // 后续段解析失败：真实加载器在前面各段之后读取的是原始张量字节；
        // 其中若已出现危险调用，上面的 flush 已计为高危（pickle 逐 opcode 执行，报错前已生效）。
        if (segNo > 1 && !(e instanceof WindowError)) {
          issue({
            ruleId: 'PICKLE_TRAILING_DATA',
            severity: 'INFO',
            title: 'Pickle 之后为非 pickle 数据',
            detail: `偏移 ${segStart} 起不再是完整 pickle（旧格式 PyTorch 的原始张量数据等），已停止解析`,
          });
          break;
        }
        throw e;
      }
    }
  } catch (e) {
    complete = false;
    if (e instanceof WindowError) {
      issue({
        ruleId: 'PICKLE_SIZE_LIMIT',
        severity: 'MEDIUM',
        title: 'Pickle 超过扫描窗口，仅分析了头部',
        detail: `已解析前 ${window} 字节 opcode（${opcodeCount} 个），其后内容未分析`,
      });
    } else {
      const why =
        e instanceof TruncatedError
          ? `数据在偏移 ${e.offset} 处截断`
          : e instanceof Error
            ? e.message
            : '未知错误';
      issue({
        ruleId: 'PICKLE_PARSE_ABORTED',
        severity: 'MEDIUM',
        title: 'Pickle 解析中止',
        detail: `解析中止：${why}`,
      });
    }
  }
  for (const g of calledUnknown) unknown.delete(g);
  if (unknown.size)
    issue({
      ruleId: 'PICKLE_UNLISTED_GLOBAL',
      severity: 'MEDIUM',
      title: 'Pickle 引用非白名单全局对象',
      detail: `${list(unknown)}（仅被引用，未发现加载时调用；需人工确认）`,
    });
  if (common.size)
    issue({
      ruleId: 'PICKLE_COMMON_GLOBAL',
      severity: 'INFO',
      title: 'Pickle 引用常见非权重对象',
      detail: `${list(common)}（整模型保存常见，未见危险调用）`,
    });
  return { globals: [...globals], issues, opcodeCount, complete };
}

type AddGlobal = (module: string, name: string, via: string) => Val;
type OnCall = (callee: Val, op: string) => void;
type Issue = (i: PickleIssue) => void;

async function readStr(cur: Cursor, n: number, enc: 'utf8' | 'latin1'): Promise<Val> {
  if (n > MAX_STR) {
    await cur.skip(n);
    return OTHER;
  }
  return { k: 'str', v: (await cur.take(n)).toString(enc) };
}

/** 解析单个 pickle 直到 STOP；返回 'stop'。未知 opcode 抛错由调用方记为“解析中止”。 */
async function parseOne(
  cur: Cursor,
  addGlobal: AddGlobal,
  onCall: OnCall,
  issue: Issue,
  tick: () => number,
): Promise<'stop'> {
  const stack: Val[] = [];
  const memo = new Map<number, Val>();
  const push = (v: Val) => {
    if (stack.length >= MAX_STACK) throw new Error('栈深度超过上限');
    stack.push(v);
  };
  const pop = (): Val => stack.pop() ?? OTHER;
  const popMark = (): Val[] => {
    const at = stack.lastIndexOf(MARK);
    if (at < 0) throw new Error('缺少 MARK');
    return stack.splice(at);
  };
  const top = (): Val => stack[stack.length - 1] ?? OTHER;
  const callOn = onCall;

  for (;;) {
    tick();
    const at = cur.pos;
    const op = await cur.byte();
    switch (op) {
      case 0x80: {
        // PROTO
        const p = await cur.byte();
        if (p > 5) throw new Error(`不支持的协议版本 ${p}`);
        break;
      }
      case 0x95:
        await cur.u64();
        break; // FRAME：仅长度提示，按字节流继续解析
      case 0x2e:
        return 'stop'; // STOP
      case 0x28:
        push(MARK);
        break; // MARK
      case 0x30:
        pop();
        break; // POP
      case 0x31:
        popMark();
        break; // POP_MARK
      case 0x32:
        push(top());
        break; // DUP
      // 行参数（数值/持久化 ID）
      case 0x46:
      case 0x49:
      case 0x4c:
      case 0x50:
        await cur.line();
        push(OTHER);
        break;
      case 0x53:
        push({ k: 'str', v: unquote(await cur.line()) });
        break; // STRING
      case 0x56:
        push({ k: 'str', v: rawUnicode(await cur.line()) });
        break; // UNICODE
      // 定长数值
      case 0x4a:
        await cur.skip(4);
        push(OTHER);
        break; // BININT
      case 0x4b:
        await cur.skip(1);
        push(OTHER);
        break; // BININT1
      case 0x4d:
        await cur.skip(2);
        push(OTHER);
        break; // BININT2
      case 0x47:
        await cur.skip(8);
        push(OTHER);
        break; // BINFLOAT
      case 0x8a:
        await cur.skip(await cur.byte());
        push(OTHER);
        break; // LONG1
      case 0x8b: {
        const n = await cur.i32();
        if (n < 0) throw new Error('LONG4 长度为负');
        await cur.skip(n);
        push(OTHER);
        break;
      }
      case 0x4e:
      case 0x88:
      case 0x89:
        push(OTHER);
        break; // NONE/NEWTRUE/NEWFALSE
      // 字符串
      case 0x54: {
        const n = await cur.i32();
        if (n < 0) throw new Error('BINSTRING 长度为负');
        push(await readStr(cur, n, 'latin1'));
        break;
      }
      case 0x55:
        push(await readStr(cur, await cur.byte(), 'latin1'));
        break; // SHORT_BINSTRING
      case 0x58:
        push(await readStr(cur, await cur.u32(), 'utf8'));
        break; // BINUNICODE
      case 0x8c:
        push(await readStr(cur, await cur.byte(), 'utf8'));
        break; // SHORT_BINUNICODE
      case 0x8d:
        push(await readStr(cur, await cur.u64(), 'utf8'));
        break; // BINUNICODE8
      // 字节串（不追踪内容）
      case 0x42:
        await cur.skip(await cur.u32());
        push(OTHER);
        break; // BINBYTES
      case 0x43:
        await cur.skip(await cur.byte());
        push(OTHER);
        break; // SHORT_BINBYTES
      case 0x8e:
      case 0x96:
        await cur.skip(await cur.u64());
        push(OTHER);
        break; // BINBYTES8/BYTEARRAY8
      case 0x97:
        push(OTHER);
        break; // NEXT_BUFFER
      case 0x98:
        break; // READONLY_BUFFER
      // 容器
      case 0x7d:
      case 0x5d:
      case 0x29:
      case 0x8f:
        push(OTHER);
        break; // EMPTY_DICT/LIST/TUPLE/SET
      case 0x64:
      case 0x6c:
      case 0x74:
      case 0x91:
        popMark();
        push(OTHER);
        break; // DICT/LIST/TUPLE/FROZENSET
      case 0x65:
      case 0x75:
      case 0x90:
        popMark();
        break; // APPENDS/SETITEMS/ADDITEMS
      case 0x61:
        pop();
        break; // APPEND
      case 0x73:
        pop();
        pop();
        break; // SETITEM
      case 0x85:
        pop();
        push(OTHER);
        break; // TUPLE1
      case 0x86:
        pop();
        pop();
        push(OTHER);
        break; // TUPLE2
      case 0x87:
        pop();
        pop();
        pop();
        push(OTHER);
        break; // TUPLE3
      // memo
      case 0x70:
        memo.set(Number(await cur.line()), top());
        break; // PUT
      case 0x71:
        memo.set(await cur.byte(), top());
        break; // BINPUT
      case 0x72:
        memo.set(await cur.u32(), top());
        break; // LONG_BINPUT
      case 0x94:
        memo.set(memo.size, top());
        break; // MEMOIZE（与 CPython 一致：索引为 len(memo)）
      case 0x67:
        push(memo.get(Number(await cur.line())) ?? OTHER);
        break; // GET
      case 0x68:
        push(memo.get(await cur.byte()) ?? OTHER);
        break; // BINGET
      case 0x6a:
        push(memo.get(await cur.u32()) ?? OTHER);
        break; // LONG_BINGET
      // 全局引用与调用
      case 0x63: {
        const m = await cur.line();
        const n = await cur.line();
        push(addGlobal(m, n, 'GLOBAL'));
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop(),
          mod = pop();
        if (mod.k === 'str' && name.k === 'str') push(addGlobal(mod.v, name.v, 'STACK_GLOBAL'));
        else {
          issue({
            ruleId: 'PICKLE_UNRESOLVED_STACK_GLOBAL',
            severity: 'MEDIUM',
            title: 'STACK_GLOBAL 参数无法静态确定',
            detail: `偏移 ${at} 处 STACK_GLOBAL 的模块/名称不是可追踪字符串`,
          });
          push({ k: 'global', v: `<偏移 ${at} 处无法静态确定的对象>`, cls: 'unknown' });
        }
        break;
      }
      case 0x69: {
        // INST
        const m = await cur.line();
        const n = await cur.line();
        popMark();
        const g = addGlobal(m, n, 'INST');
        callOn(g, 'INST');
        push(OTHER);
        break;
      }
      case 0x6f: {
        const items = popMark();
        callOn(items[1] ?? OTHER, 'OBJ');
        push(OTHER);
        break;
      } // OBJ
      case 0x52: {
        pop();
        callOn(pop(), 'REDUCE');
        push(OTHER);
        break;
      } // REDUCE
      case 0x81: {
        pop();
        callOn(pop(), 'NEWOBJ');
        push(OTHER);
        break;
      } // NEWOBJ
      case 0x92: {
        pop();
        pop();
        callOn(pop(), 'NEWOBJ_EX');
        push(OTHER);
        break;
      } // NEWOBJ_EX
      case 0x62:
        pop();
        break; // BUILD：可触发 __setstate__，对象本身已在 GLOBAL/REDUCE 处判定
      case 0x51:
        pop();
        push(OTHER);
        break; // BINPERSID
      case 0x82:
      case 0x83:
      case 0x84: {
        // EXT1/2/4
        await cur.skip(op === 0x82 ? 1 : op === 0x83 ? 2 : 4);
        issue({
          ruleId: 'PICKLE_EXTENSION_REF',
          severity: 'MEDIUM',
          title: 'Pickle 使用 copyreg 扩展码引用对象',
          detail: `偏移 ${at} 处扩展码引用无法静态确定目标`,
        });
        push(OTHER);
        break;
      }
      default:
        throw new Error(`偏移 ${at} 处遇到未知 opcode 0x${op.toString(16).padStart(2, '0')}`);
    }
  }
}
