// 鉴盾侧 TypeScript 参考实现的 JS 版（与 protocol-subset.md §6 中的 TS 代码等价），用于交叉核对测试向量。
// 用法：node canonical_ref.mjs < vectors-input.json
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// 规范化：对象键按 UTF-16 码元升序（与 Python sort_keys、Go map 键排序对 BMP 内字符一致），
// 无空白；字符串转义规则见 protocol-subset.md §6.2。
export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("only safe integers are allowed in eval payloads");
    return String(value);
  }
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => quote(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  throw new Error("unsupported type");
}

function quote(s) {
  // 拒绝孤立代理项：Python 侧 encode('utf-8') 会失败。
  if (!s.isWellFormed()) throw new Error("lone surrogate");
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export function evalJobChecksum(job) {
  const payload = { product: job.product, scenario_pack: job.scenario_pack, sink_base_url: job.sink_base_url };
  return createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
}

const cases = JSON.parse(readFileSync(0, "utf8"));
const out = cases.map((c) => {
  try {
    const payload = { product: c.job.product, scenario_pack: c.job.scenario_pack, sink_base_url: c.job.sink_base_url };
    return { name: c.name, checksum: evalJobChecksum(c.job), canonical: canonicalize(payload) };
  } catch (e) {
    return { name: c.name, error: String(e.message) };
  }
});
process.stdout.write(JSON.stringify(out) + "\n");
