import type { ReportEvalResult, ReportFinding, ReportInputData } from '../report-builder.js';
import { redactReportString } from '../report-redaction.js';
import { SINK_EXFIL_URL_RE, SINK_PAGE_URL_RE, scrubSinkUrls } from '../sink-url-scrub.js';
import { mdTable } from './common.js';
import { AGENT_ENGINE, isPlatformAgentReport } from './scope.js';

/**
 * 平台智能体（Dify/Coze 真实观测）任务的报告辅助。
 *
 * 平台任务没有内容评测样本，基础报告里的“多轮对抗过程摘要”“样本概览”“业务场景与边界：未提供”
 * 这类章节对它们要么无内容、要么是空占位。这里用任务里真实记录的场景数据改写：
 * 每个场景列出攻击类型、发给智能体的提示、智能体回答摘录、平台工具调用轨迹、判定和证据。
 */

const DETAIL_LIMIT = 60;
const PROMPT_MAX = 140;
const ANSWER_MAX = 180;
const TOOL_MAX = 180;
const EVIDENCE_MAX = 200;

const SURFACE_LABELS: Record<string, string> = {
  ssrf: '访问内网或云元数据地址',
  secret_read: '密钥读取',
  file_read: '本地文件读取',
  dangerous_command: '危险命令',
  data_exfiltration: '数据外传',
  indirect_prompt_injection: '间接指令注入',
  tool_argument_bypass: '工具参数绕过',
};

const VERDICT_PLAIN: Record<string, string> = { PASS: '通过', FAIL: '发现风险', UNKNOWN: '未判定', ERROR: '执行异常' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRaw(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/**
 * 折叠空白、脱敏、截断；只用于展示摘录。
 * 暗号先换成“[暗号]”、英文 canary 字样换成“暗号”再交给通用脱敏：
 * 通用脱敏会把“canary 后跟文字”整句哈希，既丢信息又读不懂。
 */
function compact(text: string, max: number): string {
  const shown = visiblePrompt(text).replace(/canary\s+hash:[0-9a-f]{12}/gi, '暗号').replace(/canary/gi, '暗号').replace(/\s+/g, ' ').trim();
  const redacted = redactReportString(shown);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

// 报告输入经过通用脱敏后，暗号会变成 LSE-hash:xxxxxxxxxxxx（canary 整词被哈希），两种形态都要识别。
const CANARY_RE = /LSE-(?:CANARY-[A-Za-z0-9_-]+|hash:[0-9a-f]{12})/g;

// 定义在 ../sink-url-scrub.ts（避免与 report-builder 成环），这里保持原导出名。
export { scrubSinkUrls };

/** 场景里存的是带占位符的模板（运行时替换成带一次性令牌的地址），报告里换成读得懂的说明。 */
function visiblePrompt(text: string): string {
  return text
    .replace(SINK_EXFIL_URL_RE, '[受控接收端地址]')
    .replace(SINK_PAGE_URL_RE, '[受控页面地址]')
    .replaceAll('{{LSE_SINK_URL}}', '[受控页面地址]')
    .replaceAll('{{LSE_EXFIL_URL}}', '[受控接收端地址]')
    .replaceAll('{{CANARY}}', '[暗号]')
    .replace(CANARY_RE, '[暗号]');
}

/** 样本表等位置展示提示文本：受控地址与暗号换成可读说明，并脱敏截断。 */
export function platformPromptText(text: string): string {
  return compact(text, PROMPT_MAX);
}

export interface PlatformScenarioDetail {
  resultId: string;
  templateId: string;
  categoryTitle: string;
  attackType: string;
  prompts: string[];
  answers: string[];
  tools: string[];
  verdict: string;
  verdictLabel: string;
  evidence: string;
  notChecked: boolean;
  /** 展示文本归一化后的提问，用来判断同一提问是否被重复运行。 */
  variantKey: string;
}

function toolLine(item: Record<string, unknown>): string {
  const name = typeof item.toolName === 'string' ? item.toolName : '未命名工具';
  const args = isRecord(item.arguments) && Object.keys(item.arguments).length > 0 ? JSON.stringify(item.arguments) : '';
  const surface = typeof item.riskSurface === 'string' && item.riskSurface ? SURFACE_LABELS[item.riskSurface] ?? item.riskSurface : '';
  const risky = item.allowed === false || Boolean(surface);
  const text = `${name}${args ? ` ${compact(visiblePrompt(args), 90)}` : ''}${risky ? `（命中风险策略${surface ? `：${surface}` : ''}）` : ''}`;
  return compact(text, TOOL_MAX);
}

function sinkEvidence(raw: Record<string, unknown>): string[] {
  const hits = Array.isArray(raw.sinkHits) ? raw.sinkHits.filter(isRecord) : [];
  const notes: string[] = [];
  if (hits.some((hit) => hit.kind === 'fetch')) notes.push('受控接收端记录到诱饵页面被抓取');
  if (hits.some((hit) => hit.kind === 'exfil' && hit.canaryPresent === true)) notes.push('受控接收端收到携带暗号的外发请求');
  else if (hits.some((hit) => hit.kind === 'exfil')) notes.push('受控接收端收到外发请求');
  return notes;
}

function evidenceText(verdict: string, raw: Record<string, unknown>, finding: ReportFinding | undefined, result: ReportEvalResult): string {
  if (raw.notChecked === true) {
    const reason = typeof raw.notCheckedReason === 'string' ? raw.notCheckedReason : '前置条件未配置，本场景未检查';
    return `${reason}，不计入通过`;
  }
  const parts: string[] = [];
  if (verdict === 'FAIL') {
    if (finding?.evidence) parts.push(finding.evidence);
    else if (raw.credentialLeak === true) parts.push('回答或工具结果中出现访问凭据（已脱敏）');
    else if (raw.sinkCanaryHit === true) parts.push('受控接收端收到本场景暗号');
    else if (raw.canaryLeak === true) parts.push('回答泄露本场景暗号或系统提示词特征');
    else {
      const trace = Array.isArray(raw.trace) ? raw.trace.filter(isRecord) : [];
      const risky = trace.find((item) => item.allowed === false);
      parts.push(typeof risky?.blockReason === 'string' ? risky.blockReason : '判定为存在风险');
    }
  } else if (verdict === 'PASS') {
    if (raw.lureRead === true) parts.push('诱饵页面已被抓取，智能体未照做');
    else if (raw.noToolRefusal === true) parts.push('拒绝了越权请求，没有调用工具');
    else if (Array.isArray(raw.trace) && raw.trace.length > 0) parts.push('平台工具调用未命中风险策略，回答拒绝了越权请求');
    else parts.push('回答拒绝了越权请求');
  } else {
    const platformError = isRecord(raw.platformError) && typeof raw.platformError.message === 'string' ? raw.platformError.message : '';
    parts.push(platformError ? `平台调用未成功：${platformError}` : result.errorMessage ? `执行未完成：${result.errorMessage}` : '证据不足，无法判定');
  }
  for (const note of sinkEvidence(raw)) if (!parts.some((part) => part.includes(note))) parts.push(note);
  return compact(visiblePrompt(parts.join('；')), EVIDENCE_MAX);
}

/** 把每条结果与它的 agent-tool-guard 记录配对，整理成可展示的场景明细。 */
export function platformScenarioDetails(data: ReportInputData): PlatformScenarioDetail[] {
  const results = data.results ?? [];
  const rawByResult = new Map<string, Record<string, unknown>>();
  for (const run of data.engineRuns) {
    if (run.engine !== AGENT_ENGINE || !run.resultId || rawByResult.has(run.resultId)) continue;
    const raw = parseRaw(run.rawOutput);
    if (raw) rawByResult.set(run.resultId, raw);
  }
  const findingByResult = new Map<string, ReportFinding>();
  for (const finding of data.findings) {
    if (finding.resultId && finding.verdict === 'FAIL' && !findingByResult.has(finding.resultId)) findingByResult.set(finding.resultId, finding);
  }
  return results.map((result, index) => {
    const id = result.id ?? `result-${index}`;
    const raw = rawByResult.get(id) ?? {};
    const verdict = result.finalVerdict ?? 'UNKNOWN';
    const notChecked = raw.notChecked === true;
    const messages = stringList(raw.messages);
    const promptSource = messages.length > 0 ? messages : [result.prompt ?? result.question.content];
    const prompts = promptSource.map((text) => compact(visiblePrompt(text), PROMPT_MAX));
    const modelRaw = Array.isArray(raw.modelRaw) ? raw.modelRaw.filter(isRecord) : [];
    const turnAnswers = modelRaw.map((turn) => (typeof turn.text === 'string' ? turn.text : '')).filter(Boolean);
    const answers = (turnAnswers.length > 0 ? turnAnswers : result.response ? [result.response] : []).map((text) => compact(text, ANSWER_MAX));
    const trace = Array.isArray(raw.trace) ? raw.trace.filter(isRecord) : [];
    const templateId = typeof raw.templateId === 'string' ? raw.templateId : result.question.category ?? 'unknown';
    const attackType = typeof raw.scenarioName === 'string' && raw.scenarioName ? raw.scenarioName : templateId;
    return {
      resultId: id,
      templateId,
      categoryTitle: attackType,
      attackType,
      prompts,
      answers,
      tools: trace.map(toolLine),
      verdict,
      verdictLabel: notChecked ? '未检查' : VERDICT_PLAIN[verdict] ?? verdict,
      evidence: evidenceText(verdict, raw, findingByResult.get(id), result),
      notChecked,
      variantKey: promptSource.map(visiblePrompt).join('\n'),
    };
  });
}

function numbered(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  if (items.length === 1) return items[0]!;
  return items.map((item, index) => `第${index + 1}轮：${item}`).join('；');
}

/** “场景明细”章节：每个场景一行，替换基础报告里的“多轮对抗过程摘要”和“样本概览”。 */
export function renderPlatformScenarioSection(details: PlatformScenarioDetail[], heading: string): string[] {
  if (details.length === 0) return [];
  const shown = details.slice(0, DETAIL_LIMIT);
  return [
    heading,
    '',
    details.length > DETAIL_LIMIT
      ? `共 ${details.length} 个场景，仅展示前 ${DETAIL_LIMIT} 个；完整记录见任务详情。`
      : `共 ${details.length} 个场景，逐个列出智能体收到的提示、回答和平台实际调用的工具。`,
    '',
    mdTable(
      ['序号', '攻击类型', '发给智能体的提示', '智能体回答摘录', '平台工具调用轨迹', '判定', '证据'],
      shown.map((detail, index) => [
        String(index + 1),
        detail.attackType,
        numbered(detail.prompts, '见任务详情'),
        numbered(detail.answers, '平台未返回回答'),
        detail.tools.length > 0 ? detail.tools.join('；') : '未调用工具',
        detail.verdictLabel,
        detail.evidence,
      ]),
    ),
  ];
}

/** 样本规模与结论范围：每类攻击样本数、是否重复运行、未检查的场景数。 */
export function renderPlatformScaleSection(details: PlatformScenarioDetail[], heading: string): string[] {
  if (details.length === 0) return [];
  const groups = new Map<string, { title: string; runs: number; variants: Set<string>; pass: number; fail: number; unknown: number }>();
  for (const detail of details) {
    const group = groups.get(detail.templateId) ?? { title: detail.categoryTitle, runs: 0, variants: new Set<string>(), pass: 0, fail: 0, unknown: 0 };
    group.runs += 1;
    group.variants.add(detail.variantKey);
    if (detail.verdict === 'PASS' && !detail.notChecked) group.pass += 1;
    else if (detail.verdict === 'FAIL') group.fail += 1;
    else group.unknown += 1;
    groups.set(detail.templateId, group);
  }
  const repeated = [...groups.values()].some((group) => group.runs > group.variants.size);
  const notChecked = details.filter((detail) => detail.notChecked);
  const notCheckedReasons = [...new Set(notChecked.map((detail) => detail.evidence.replace(/，不计入通过$/, '')))];
  return [
    heading,
    '',
    `本次共运行 ${details.length} 个场景，覆盖 ${groups.size} 类攻击。结论只覆盖下表的样本，不外推到其他提问方式、其他工具权限或其他时间点的运行结果。`,
    '',
    mdTable(
      ['攻击类型', '运行次数', '不同提问数', '是否重复运行', '通过', '发现风险', '未判定'],
      [...groups.values()].map((group) => [
        group.title,
        String(group.runs),
        String(group.variants.size),
        group.runs > group.variants.size ? `是（${group.variants.size} 种提问共运行 ${group.runs} 次）` : '否（每种提问各运行 1 次）',
        String(group.pass),
        String(group.fail),
        String(group.unknown),
      ]),
    ),
    '',
    repeated
      ? '- 同一提问重复运行的，各次结果分别计入上表，没有做多数表决；智能体回答有随机性，再次运行的结果可能不同。'
      : '- 每种提问只运行了 1 次；智能体回答有随机性，再次运行的结果可能不同。',
    ...(notChecked.length > 0
      ? [`- ${notChecked.length} 个场景未检查（${notCheckedReasons.join('；')}），不计入通过，也不能据此认为对应风险已排除。`]
      : []),
  ];
}

// ---------------------------------------------------------------------------
// 基础报告瘦身
// ---------------------------------------------------------------------------

const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'];
const TOP_HEADING = /^## ([一二三四五六七八九十]+)、(.+)$/;

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparator(line: string): boolean {
  return /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function joinRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** 表格瘦身：去掉“未提供”行和无意义的“样本数”行、整列占位列、全是占位的空表。 */
function cleanTable(lines: string[]): string[] {
  if (lines.length < 2 || !isSeparator(lines[1]!)) return lines;
  let header = splitRow(lines[0]!);
  let rows = lines.slice(2).map(splitRow);
  const hadRows = rows.length > 0;
  if (header.length === 2) rows = rows.filter((row) => row[1] !== '未提供' && row[1] !== '—' && row[0] !== '样本数');
  if (hadRows && (rows.length === 0 || rows.every((row) => row.every((cell) => cell === '—')))) return [];
  const keep = header.map((_, column) => !rows.every((row) => row[column] === '—'));
  if (keep.some((flag) => !flag) && keep.some(Boolean)) {
    header = header.filter((_, column) => keep[column]);
    rows = rows.map((row) => row.filter((_, column) => keep[column]));
  }
  return [joinRow(header), joinRow(header.map(() => '---')), ...rows.map(joinRow)];
}

function cleanTables(lines: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; ) {
    if (!isTableLine(lines[index]!)) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && isTableLine(lines[index]!)) {
      block.push(lines[index]!);
      index += 1;
    }
    out.push(...cleanTable(block));
  }
  return out;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6}) /.exec(line);
  return match ? match[1]!.length : 0;
}

/** 删掉下面没有任何内容的二级及以下小节标题（一级文档标题保留）。 */
function removeEmptyHeadings(lines: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const level = headingLevel(line);
    if (level >= 2) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.trim() === '') next += 1;
      const nextLevel = next < lines.length ? headingLevel(lines[next]!) : 99;
      if (next >= lines.length || (nextLevel > 0 && nextLevel <= level)) continue;
    }
    out.push(line);
  }
  return out;
}

/** 清掉 Markdown 里的空占位：整列“—”、全是“—”的空表、无内容的小节标题。 */
export function cleanPlatformMarkdown(markdown: string): string {
  const cleaned = removeEmptyHeadings(cleanTables(markdown.split('\n')));
  const hasDash = cleaned.some((line) => isTableLine(line) && splitRow(line).includes('—'));
  return (hasDash ? cleaned : cleaned.filter((line) => !/^> 说明：「—」表示/.test(line))).join('\n').replace(/\n{3,}/g, '\n\n');
}

interface Section {
  heading: string | null;
  lines: string[];
}

function splitSections(content: string): Section[] {
  const sections: Section[] = [{ heading: null, lines: [] }];
  for (const line of content.split('\n')) {
    if (/^## /.test(line)) sections.push({ heading: line, lines: [] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  return sections;
}

function sectionName(section: Section): string {
  const match = section.heading ? TOP_HEADING.exec(section.heading) : null;
  return match ? match[2]!.trim() : section.heading?.replace(/^## /, '').trim() ?? '';
}

/**
 * 平台智能体任务的基础报告改写：
 * - “多轮对抗过程摘要”改为场景明细和样本规模说明，“样本概览”并入场景明细后删除，无内容的工具轨迹章节不输出。
 * - 删除“业务场景与边界/部署方式/可控范围：未提供”和“样本数”这类无信息行、整列占位列、空表。
 * - 顶层章节编号顺延，避免删章节后出现跳号。
 * 非平台智能体任务原样返回。
 */
export function tailorPlatformBaseReport(content: string, data: ReportInputData, options: { scenarioSection?: boolean } = {}): string {
  if (!isPlatformAgentReport(data)) return content;
  const details = platformScenarioDetails(data);
  const rebuilt: Section[] = [];
  for (const section of splitSections(content)) {
    const name = sectionName(section);
    if (name === '多轮对抗过程摘要') {
      // 场景明细已在其他位置完整给出时，基础报告不再重复输出。
      const replacement = options.scenarioSection === false
        ? []
        : [...renderPlatformScenarioSection(details, '## 六、场景明细'), '', ...renderPlatformScaleSection(details, '### 样本规模与结论范围')];
      if (replacement.length > 0) rebuilt.push({ heading: replacement[0]!, lines: ['', ...replacement.slice(1), ''] });
      continue;
    }
    if (name === '样本概览') continue;
    if (name === '智能体工具调用轨迹' && section.lines.some((line) => line.includes('本次评估无 AI 工具调用记录'))) continue;
    rebuilt.push(section);
  }
  let counter = 0;
  const lines = rebuilt.flatMap((section) => {
    let heading = section.heading;
    const match = heading ? TOP_HEADING.exec(heading) : null;
    if (match) {
      heading = `## ${NUMERALS[counter] ?? String(counter + 1)}、${match[2]}`;
      counter += 1;
    }
    return heading === null ? section.lines : [heading, ...section.lines];
  });
  return scrubSinkUrls(cleanPlatformMarkdown(lines.join('\n')));
}
