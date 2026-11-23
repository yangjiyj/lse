import type { ModelFacingText } from './extract.js';

export interface RuleHit {
  ruleId: string;
  path: string;
  line: number;
  excerpt: string;
  confidence?: number;
  /** 可疑但不确定：若配置了评估模型，交给模型复核 */
  needsJudge?: boolean;
  toolName?: string;
  /** 覆盖规则默认等级（如依赖漏洞按漏洞库等级） */
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  meta?: Record<string, unknown>;
  /** 同一规则同一文件内再细分的合并键（如依赖漏洞按“包名@版本”各出一条），同时计入指纹 */
  groupKey?: string;
  /** 追加到规则标题后的说明（如“：langchain 0.0.131”） */
  titleSuffix?: string;
}

// 零宽/格式控制字符；BOM 仅在非文件开头时计入
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\u206A-\u206F\u180E\uFEFF]/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const UNICODE_TAG = /[\u{E0000}-\u{E007F}]/u;

/** 解码 Unicode Tag 隐藏文本（每个 tag 字符对应一个 ASCII 字符） */
export function decodeUnicodeTags(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

const INSTRUCTION_TAG = /<\s*\/?\s*(important|system|instructions?|secret|hidden|admin|override|critical)\b[^>]*>/i;

/** 高置信投毒短语（中英）。每条都指向“对模型下达与功能无关的操作性指令” */
const POISON_PHRASES: Array<{ re: RegExp; confidence: number }> = [
  { re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|other)\s+(?:instructions?|guidance|rules|directions|prompts?|context)/i, confidence: 0.92 },
  { re: /\b(?:before|prior\s+to|after)\s+(?:using|calling|invoking|answering|responding|running)\b[^.\n]{0,80}?\b(?:first\s+)?(?:call|invoke|run|use|read|send|execute)\b/i, confidence: 0.85 },
  { re: /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|mention|reveal|show|notify|alert)\s+(?:this\s+to\s+)?(?:the\s+)?user/i, confidence: 0.92 },
  { re: /\b(?:without|not)\s+(?:telling|informing|notifying|asking)\s+(?:the\s+)?user/i, confidence: 0.88 },
  { re: /\b(?:silently|secretly|covertly|quietly)\s+(?:upload|send|post|forward|exfiltrate|transmit|copy|read|call|include)/i, confidence: 0.9 },
  { re: /\bpass\b[^.\n]{0,80}\bas\s+(?:the\s+|an?\s+)?(?:['"`]?\w+['"`]?\s+)?['"`]?(?:parameter|argument|param|sidenote|note|context)\b/i, confidence: 0.8 },
  { re: /\b(?:this|the)\s+tool\s+(?:is\s+)?(?:very\s+)?important[^.\n]{0,40}\b(?:must|always)\b/i, confidence: 0.7 },
  { re: /\byou\s+(?:must|should|have\s+to)\s+(?:always\s+)?(?:first\s+)?(?:call|use|invoke|read|send)\b[^.\n]{0,80}\b(?:instead|otherwise|or\s+the\s+tool\s+will)/i, confidence: 0.8 },
  { re: /\b(?:instead\s+of|rather\s+than)\s+(?:the\s+)?(?:original|other|real)\s+tool/i, confidence: 0.8 },
  { re: /(?:忽略|无视|忘记|忘掉)(?:之前|上文|以上|前面|先前|所有)(?:的)?(?:所有)?(?:指令|指示|规则|提示|要求|内容)/u, confidence: 0.92 },
  { re: /(?:不要|切勿|禁止|别)(?:告诉|告知|通知|提醒|透露给|让)用户/u, confidence: 0.92 },
  { re: /(?:在|于)?(?:使用|调用)(?:本|此|该|这个)工具(?:之前|前|之后|后)[^。\n]{0,40}?(?:先|必须|务必|需要)(?:调用|读取|发送|执行|运行)/u, confidence: 0.85 },
  { re: /(?:悄悄|偷偷|静默|秘密)(?:地)?(?:上传|发送|读取|调用|转发|复制)/u, confidence: 0.9 },
  { re: /绕过(?:审批|审核|确认|用户确认|安全检查)/u, confidence: 0.85 },
  { re: /作为(?:参数|附加参数|备注|sidenote)(?:传入|传递|发送)/u, confidence: 0.8 },
];

/** 强敏感凭据路径：面向模型文本要求读取即高度可疑 */
export const SENSITIVE_PATH =
  /(?:~|\$HOME|%USERPROFILE%|\/home\/\w+|\/root)?\/?\.(?:ssh\/(?:id_[a-z0-9]+|authorized_keys|config)|ssh\b|aws\/credentials|aws\/config|kube\/config|docker\/config\.json|pypirc|netrc|git-credentials|gnupg|cursor\/mcp\.json|config\/gcloud)|\bid_rsa\b|\bid_ed25519\b|\/etc\/shadow\b|claude_desktop_config\.json/i;
/** 弱敏感路径：常见于正常说明（“在 .env 中配置…”），只在配合外发类动词时报 */
const WEAK_SENSITIVE_PATH = /(?:^|[\s'"`(/])\.env(?:\.local|\.production)?\b|\bmcp\.json\b|\.npmrc\b|\bcredentials?\.json\b/i;

// 动词允许后接下划线（send_email / upload_file 这类工具名同样是指令）
const READ_VERB = /(?<![A-Za-z])(?:read|cat|open|load|include|attach|send|upload|pass|get|fetch|copy|access|contents?)(?![a-z])|读取|读|发送|上传|附上|包含|获取|传入|复制/iu;
const EXFIL_VERB = /(?<![A-Za-z])(?:send|upload|post|forward|attach|exfiltrate|append)(?![a-z])|include\s+(?:its|the)\s+content|pass\s+(?:its|the)?\s*content|发送|上传|附上|转发|作为参数/iu;

const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const DECODED_SUSPICIOUS = /ignore|instruction|previous|do not tell|call|send|ssh|password|secret|token|credential|curl|http|忽略|指令|发送/i;

function excerptAround(text: string, index: number, width = 160): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, start + width).replace(/\s+/g, ' ').trim();
}

function lineOffset(t: ModelFacingText, index: number): number {
  let extra = 0;
  for (let k = 0; k < index; k++) if (t.text.charCodeAt(k) === 10) extra++;
  return t.kind === 'skill_doc' ? t.line + extra : t.line;
}

export function detectPoisoning(texts: ModelFacingText[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const t of texts) {
    const base = { path: t.path, toolName: t.toolName };
    const body = t.kind === 'skill_doc' ? t.text.replace(/^\uFEFF/, '') : t.text;
    // 1. 不可见字符
    for (const [re, label] of [[UNICODE_TAG, 'Unicode Tag'], [ZERO_WIDTH, '零宽字符'], [BIDI, '双向控制符']] as const) {
      const m = re.exec(body);
      if (!m) continue;
      const hidden = label === 'Unicode Tag' ? decodeUnicodeTags(body) : '';
      hits.push({
        ...base,
        ruleId: 'mcp.hidden_unicode',
        line: lineOffset(t, m.index),
        excerpt: `${label} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}${hidden ? `，解码隐藏文本：${hidden.slice(0, 160)}` : ''}`,
        confidence: label === 'Unicode Tag' ? 0.95 : 0.85,
      });
    }
    const visible = body.replace(/[\u{E0000}-\u{E007F}]/gu, '');
    const decodedTags = decodeUnicodeTags(body);
    const scanTargets = decodedTags ? [visible, decodedTags] : [visible];
    for (const target of scanTargets) {
      // 2. 指令标签
      const tag = INSTRUCTION_TAG.exec(target);
      if (tag) hits.push({ ...base, ruleId: 'mcp.tool_poisoning', line: lineOffset(t, tag.index), excerpt: excerptAround(target, tag.index), confidence: 0.85 });
      // 3. 投毒短语
      for (const p of POISON_PHRASES) {
        const m = p.re.exec(target);
        if (m) hits.push({ ...base, ruleId: 'mcp.tool_poisoning', line: lineOffset(t, m.index), excerpt: excerptAround(target, m.index), confidence: p.confidence });
      }
      // 4. 敏感路径 + 读取/发送动词（同一句内；“~/.ssh” 中的点不算句末）
      for (const sentence of target.split(/(?<=[。！？])|\n\s*\n|(?<=[.!?])(?=\s)/u)) {
        const strong = SENSITIVE_PATH.exec(sentence);
        const weak = strong ? null : WEAK_SENSITIVE_PATH.exec(sentence);
        const sp = strong && READ_VERB.test(sentence) ? strong : weak && EXFIL_VERB.test(sentence) ? weak : null;
        if (sp) {
          const idx = target.indexOf(sentence) + sp.index;
          hits.push({ ...base, ruleId: 'mcp.sensitive_path_instruction', line: lineOffset(t, idx), excerpt: excerptAround(target, idx) });
          break;
        }
      }
    }
    // 5. Base64 隐藏片段
    for (const m of visible.matchAll(BASE64_RUN)) {
      let decoded = '';
      try {
        decoded = Buffer.from(m[0], 'base64').toString('utf8');
      } catch {
        continue;
      }
      const printable = decoded.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '').length / Math.max(1, decoded.length);
      if (printable > 0.9 && DECODED_SUSPICIOUS.test(decoded)) {
        hits.push({ ...base, ruleId: 'mcp.encoded_payload', line: lineOffset(t, m.index ?? 0), excerpt: `解码内容：${decoded.slice(0, 160)}` });
      }
    }
    // 6. 可疑但非高置信：描述里命令式长文本，交评估模型复核
    if (!hits.some((h) => h.path === t.path && h.toolName === t.toolName) && t.kind !== 'skill_doc') {
      if (/\b(?:must|always|never|important|required)\b|必须|务必|一定要|始终/iu.test(visible) && visible.length > 200) {
        hits.push({ ...base, ruleId: 'mcp.tool_poisoning', line: t.line, excerpt: excerptAround(visible, 0), confidence: 0.4, needsJudge: true });
      }
    }
  }
  return hits;
}
