// 打码副本：只把敏感信息（sensitive-rules 的 40 类）换成「[类型]」，违规关键词和自定义规则命中不换；
// 格式和原文件一致、行数不变，边读边打码边输出：
// - jsonl：逐行处理，只改 JSON 字符串值（键名不动），改过的值重新转义；
// - json 数组：与扫描解析共用 formats.ts 的数组状态机，按元素处理（只改字符串值），元素外的括号、逗号、
//   空白原样输出，单行几十兆的数组也能逐个元素吐出去；
// - csv：按单元格处理，引号里的逗号、换行照留，改过的单元格按原样加引号；
// - txt：逐行处理。
// 行、元素、单元格的缓冲都以 DEFAULT_MAX_RECORD_CHARS 为上限（与扫描时单条记录的上限一致）：超过的部分
// 扫描时记为非法、没有检测，这里也原样透传，不再缓冲。
// 纯函数，只用可擦除的 TS 语法。
import { DEFAULT_MAX_RECORD_CHARS, createJsonArrayWalker, type Container } from './formats.ts';
import { maskSensitiveCounted } from './sensitive-rules.ts';

export interface CorpusMasker {
  push(chunk: string): string;
  end(): string;
  /** 已替换的敏感信息个数 */
  masked(): number;
}

export interface MaskerOptions {
  /** 行、元素、单元格的缓冲上限，默认与扫描的单条记录上限一致 */
  maxChars?: number;
}

/** 一段 JSON 文本里，把字符串值逐个打码（键名、坏掉的字符串原样保留）。 */
function maskJsonText(line: string, add: (n: number) => void): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const q = line.indexOf('"', i);
    if (q < 0) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, q);
    let j = q + 1;
    let esc = false;
    for (; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) break;
    }
    if (j >= line.length) {
      out += line.slice(q);
      break;
    }
    const token = line.slice(q, j + 1);
    i = j + 1;
    let k = i;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      k += 1;
    }
    if (line[k] === ':') {
      out += token;
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(token);
    } catch {
      out += token;
      continue;
    }
    const r = maskSensitiveCounted(decoded as string);
    if (r.count > 0) {
      add(r.count);
      out += JSON.stringify(r.text);
    } else out += token;
  }
  return out;
}

/** 按行打码；一行超过上限时已缓冲的部分和这行剩下的部分原样输出。 */
function lineMasker(
  maskLine: (line: string) => string,
  maxChars: number,
): { push(chunk: string): string; end(): string } {
  let buf = '';
  let passing = false; // 当前行超长，原样透传到行尾
  const one = (raw: string) => {
    const cr = raw.endsWith('\r');
    const body = cr ? raw.slice(0, -1) : raw;
    return maskLine(body) + (cr ? '\r' : '');
  };
  return {
    push(chunk: string) {
      let out = '';
      let start = 0;
      if (passing) {
        const nl = chunk.indexOf('\n');
        if (nl < 0) return chunk;
        out += chunk.slice(0, nl + 1);
        passing = false;
        start = nl + 1;
      }
      const nl = chunk.lastIndexOf('\n');
      if (nl >= start) {
        const done = buf + chunk.slice(start, nl);
        buf = '';
        out += done.split('\n').map(one).join('\n') + '\n';
        start = nl + 1;
      }
      buf += chunk.slice(start);
      if (buf.length > maxChars) {
        out += buf;
        buf = '';
        passing = true;
      }
      return out;
    },
    end() {
      const rest = buf;
      buf = '';
      if (passing) return rest;
      return rest === '' ? '' : one(rest);
    },
  };
}

/** json 数组：按元素打码，元素外的字符原样输出；元素超过上限时原样透传。 */
function jsonArrayMasker(
  add: (n: number) => void,
  maxChars: number,
): { push(chunk: string): string; end(): string } {
  let out = '';
  let elem = '';
  let passing = false;
  const walker = createJsonArrayWalker({
    outside: (text) => {
      out += text;
    },
    elemStart: () => {
      elem = '';
      passing = false;
    },
    elem: (text) => {
      if (passing) {
        out += text;
        return;
      }
      elem += text;
      if (elem.length > maxChars) {
        out += elem;
        elem = '';
        passing = true;
      }
    },
    elemEnd: () => {
      if (!passing) out += maskJsonText(elem, add);
      elem = '';
      passing = false;
    },
    error: () => undefined,
  });
  const take = () => {
    const s = out;
    out = '';
    return s;
  };
  return {
    push(chunk: string) {
      walker.push(chunk);
      return take();
    },
    end() {
      walker.end();
      return take();
    },
  };
}

/** CSV：逐个单元格打码。引号单元格先去转义再打码，改过的重新转义加引号；分隔符和换行原样输出。 */
function csvMasker(
  add: (n: number) => void,
  maxChars: number,
): { push(chunk: string): string; end(): string } {
  let cell = '';
  let started = false; // 单元格里已经有字符（含开头的引号）；超长透传时 cell 已清空，靠它判断
  let inQuotes = false;
  let quoteSeen = false;
  let passing = false; // 当前单元格超长，原样透传到单元格结束
  const flushCell = (): string => {
    const raw = cell;
    cell = '';
    started = false;
    if (passing) {
      passing = false;
      return raw;
    }
    if (!raw.startsWith('"')) {
      const r = maskSensitiveCounted(raw);
      if (r.count === 0) return raw;
      add(r.count);
      return r.text;
    }
    // "内容"后面可能跟着不规范的尾巴，照留
    let inner = '';
    let k = 1;
    for (; k < raw.length; k++) {
      const ch = raw[k]!;
      if (ch === '"') {
        if (raw[k + 1] === '"') {
          inner += '"';
          k += 1;
        } else break;
      } else inner += ch;
    }
    const tail = raw.slice(k + 1);
    const r = maskSensitiveCounted(inner);
    if (r.count === 0) return raw;
    add(r.count);
    return `"${r.text.replace(/"/g, '""')}"${tail}`;
  };
  return {
    push(chunk: string) {
      let out = '';
      const spill = () => {
        if (cell.length > maxChars) {
          out += cell;
          cell = '';
          passing = true;
        }
      };
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]!;
        if (inQuotes) {
          cell += ch;
          if (quoteSeen) {
            quoteSeen = false;
            if (ch === '"') {
              spill(); // "" 转义
              continue;
            }
            inQuotes = false; // 引号结束，当前字符按引号外处理
            cell = cell.slice(0, -1);
          } else {
            if (ch === '"') quoteSeen = true;
            spill();
            continue;
          }
        }
        if (ch === '"' && !started) {
          inQuotes = true;
          started = true;
          cell += ch;
        } else if (ch === ',' || ch === '\n' || ch === '\r') {
          out += flushCell() + ch;
          continue;
        } else {
          started = true;
          cell += ch;
        }
        spill();
      }
      // 透传中的单元格不留到下一块
      if (passing && cell !== '') {
        out += cell;
        cell = '';
      }
      return out;
    },
    end() {
      return cell === '' && !passing ? '' : flushCell();
    },
  };
}

export function createCorpusMasker(container: Container, opts: MaskerOptions = {}): CorpusMasker {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_RECORD_CHARS;
  let count = 0;
  const add = (n: number) => {
    count += n;
  };
  const inner =
    container === 'csv'
      ? csvMasker(add, maxChars)
      : container === 'json'
        ? jsonArrayMasker(add, maxChars)
        : container === 'txt'
          ? lineMasker((line) => {
              const r = maskSensitiveCounted(line);
              add(r.count);
              return r.text;
            }, maxChars)
          : lineMasker((line) => maskJsonText(line, add), maxChars);
  return { push: (c) => inner.push(c), end: () => inner.end(), masked: () => count };
}

/** 一次性打码整段文本（测试和小文件用）。 */
export function maskCorpusText(
  text: string,
  container: Container,
  opts: MaskerOptions = {},
): { text: string; masked: number } {
  const m = createCorpusMasker(container, opts);
  const out = m.push(text) + m.end();
  return { text: out, masked: m.masked() };
}
