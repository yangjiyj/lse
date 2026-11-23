import { lex, lineAt, type CodeLang } from './lexer.js';

/** 面向模型的文本：工具描述、参数描述、技能说明、提示/资源定义。投毒规则只看这些。 */
export interface ModelFacingText {
  path: string;
  line: number;
  kind: 'tool_description' | 'param_description' | 'skill_doc' | 'prompt' | 'resource';
  toolName?: string;
  text: string;
}

export interface ExtractedTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  /** MCP 工具注解（readOnlyHint 等），仅 JSON 工具清单可得 */
  annotations?: Record<string, unknown>;
  path: string;
  line: number;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lineOfLiteral(content: string, text: string, from = 0): number {
  const needle = JSON.stringify(text).slice(1, -1).slice(0, 80);
  const idx = needle ? content.indexOf(needle, from) : -1;
  return idx < 0 ? 1 : lineAt(content, idx);
}

function collectSchemaDescriptions(
  schema: unknown,
  sink: (text: string) => void,
  depth = 0,
): void {
  if (depth > 8 || !isRecord(schema)) return;
  if (typeof schema.description === 'string') sink(schema.description);
  if (typeof schema.title === 'string') sink(schema.title);
  for (const key of ['properties', 'definitions', '$defs']) {
    const props = schema[key];
    if (isRecord(props)) for (const v of Object.values(props)) collectSchemaDescriptions(v, sink, depth + 1);
  }
  if (schema.items) collectSchemaDescriptions(schema.items, sink, depth + 1);
  for (const key of ['default', 'examples', 'enum']) {
    const v = schema[key];
    if (typeof v === 'string') sink(v);
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') sink(x);
  }
}

/** JSON：tools/list 结果、manifest、mcp 配置里任何 {name, description} 对象 */
function fromJson(path: string, content: string, texts: ModelFacingText[], tools: ExtractedTool[]) {
  if (content.length > MAX_JSON_BYTES) return;
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return;
  }
  const walk = (node: unknown, depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const name = typeof node.name === 'string' ? node.name : undefined;
    const schema = node.inputSchema ?? node.input_schema ?? node.parameters;
    // 工具清单类文件中无 name 的 description 同样面向模型
    if (!name && typeof node.description === 'string' && /tool|mcp|manifest|schema|plugin/i.test(path)) {
      texts.push({ path, line: lineOfLiteral(content, node.description), kind: 'tool_description', text: node.description });
    }
    if (name && typeof node.description === 'string') {
      const line = lineOfLiteral(content, node.description);
      const kind: ModelFacingText['kind'] =
        'uri' in node || 'uriTemplate' in node ? 'resource' : 'arguments' in node ? 'prompt' : 'tool_description';
      texts.push({ path, line, kind, toolName: name, text: node.description });
      if (kind === 'tool_description' && (schema !== undefined || depth > 0)) {
        tools.push({ name, description: node.description, inputSchema: schema, ...(isRecord(node.annotations) ? { annotations: node.annotations } : {}), path, line });
      }
    }
    if (name && schema) {
      collectSchemaDescriptions(schema, (text) =>
        texts.push({ path, line: lineOfLiteral(content, text), kind: 'param_description', toolName: name, text }),
      );
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'inputSchema' && k !== 'input_schema') walk(v, depth + 1);
  };
  walk(root, 0);
}

const PY_TOOL_DECORATOR = /@\s*[A-Za-z_][\w.]*\.(?:tool|prompt|resource)\s*(\([^)]*\))?\s*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g;

function fromPython(path: string, content: string, texts: ModelFacingText[], tools: ExtractedTool[]) {
  const views = lex(content, 'py');
  for (const m of views.code.matchAll(PY_TOOL_DECORATOR)) {
    const name = m[2]!;
    const defEnd = (m.index ?? 0) + m[0].length;
    // 装饰器参数 description="..."
    const args = m[1] ?? '';
    const kw = /description\s*=\s*(?:[rRuU]?)("""|'''|"|')([\s\S]*?)\1/.exec(args);
    // 函数体首个字符串 = docstring（跳过签名里的默认值字符串）
    let depth = 0;
    let close = defEnd - 1;
    for (let k = defEnd - 1; k < views.bare.length; k++) {
      if (views.bare[k] === '(') depth++;
      else if (views.bare[k] === ')' && --depth === 0) {
        close = k;
        break;
      }
    }
    const bodyStart = views.bare.indexOf(':', close) + 1;
    const doc = views.strings.find((s) => s.start >= bodyStart && s.start < bodyStart + 4000);
    const between = doc ? views.bare.slice(bodyStart, doc.start) : '';
    const docText = doc && /^\s*$/.test(between) ? doc.value : '';
    const description = (kw?.[2] ?? '') + (kw && docText ? '\n' : '') + docText;
    const line = lineAt(content, doc && docText ? doc.start : (m.index ?? 0));
    const kind = /\.prompt\s*$/.test(m[0].split('(')[0] ?? '') ? 'prompt' : 'tool_description';
    if (description) texts.push({ path, line, kind, toolName: name, text: description });
    tools.push({ name, description, path, line });
  }
  // pydantic Field(description="...") / Annotated 参数说明
  for (const m of views.code.matchAll(/Field\s*\([^)]*?description\s*=\s*("""|'''|"|')([\s\S]*?)\1/g)) {
    texts.push({ path, line: lineAt(content, m.index ?? 0), kind: 'param_description', text: m[2]! });
  }
}

function fromJs(path: string, content: string, texts: ModelFacingText[], tools: ExtractedTool[]) {
  const views = lex(content, 'js');
  const strAt = (offset: number) => views.strings.find((s) => s.start >= offset && s.start < offset + 400);
  // server.tool("name", "description", ...) / server.prompt(...)
  for (const m of views.code.matchAll(/\.\s*(tool|prompt|resource)\s*\(\s*(['"`])([\w.:-]+)\2\s*,\s*(?=['"`])/g)) {
    const s = strAt((m.index ?? 0) + m[0].length);
    if (!s) continue;
    const kind = m[1] === 'tool' ? 'tool_description' : m[1] === 'prompt' ? 'prompt' : 'resource';
    const line = lineAt(content, s.start);
    texts.push({ path, line, kind, toolName: m[3], text: s.value });
    if (kind === 'tool_description') tools.push({ name: m[3]!, description: s.value, path, line });
  }
  // registerTool("name", { description: "..." }) 与 tools: [{ name: 'x', description: '...' }]
  for (const m of views.code.matchAll(/\bdescription\s*:\s*(?=['"`])/g)) {
    const s = strAt((m.index ?? 0) + m[0].length);
    if (!s || texts.some((t) => t.path === path && t.text === s.value)) continue;
    const before = views.code.slice(Math.max(0, (m.index ?? 0) - 600), m.index);
    const nameMatch = [...before.matchAll(/(?:registerTool\s*\(\s*|\bname\s*:\s*)(['"`])([\w.:-]+)\1/g)].pop();
    const line = lineAt(content, s.start);
    const isTool = !!nameMatch;
    texts.push({ path, line, kind: isTool ? 'tool_description' : 'param_description', toolName: nameMatch?.[2], text: s.value });
    if (isTool) tools.push({ name: nameMatch![2]!, description: s.value, path, line });
  }
  // zod .describe("...")
  for (const m of views.code.matchAll(/\.describe\s*\(\s*(?=['"`])/g)) {
    const s = strAt((m.index ?? 0) + m[0].length);
    if (s) texts.push({ path, line: lineAt(content, s.start), kind: 'param_description', text: s.value });
  }
}

export function isSkillDocPath(path: string): boolean {
  return /(?:^|\/)(?:skill|agents|claude|prompt|instructions?)\.md$/i.test(path) || /(?:^|\/)prompts?\//i.test(path);
}

export function extractModelFacing(
  files: Array<{ path: string; content: string; lang: CodeLang }>,
): { texts: ModelFacingText[]; tools: ExtractedTool[] } {
  const texts: ModelFacingText[] = [];
  const tools: ExtractedTool[] = [];
  for (const f of files) {
    if (f.lang === 'data' && /\.json$/i.test(f.path)) fromJson(f.path, f.content, texts, tools);
    else if (f.lang === 'py') fromPython(f.path, f.content, texts, tools);
    else if (f.lang === 'js') fromJs(f.path, f.content, texts, tools);
    else if (f.lang === 'md' && isSkillDocPath(f.path)) texts.push({ path: f.path, line: 1, kind: 'skill_doc', text: f.content });
  }
  return { texts, tools };
}
