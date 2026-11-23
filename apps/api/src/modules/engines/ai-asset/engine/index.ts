import { createHash } from 'node:crypto';
import { oversizeReason } from '../archive.js';
import { aiAssetRule, taxonomyForAiAssetRule, type AiRuleSeverity } from '../taxonomy.js';
import { detectCodeRisks, type SourceFile } from './code-rules.js';
import { detectOverbroadPermissions, detectSecrets, detectUnauthenticatedListener, redactLine } from './config-rules.js';
import { extractModelFacing, isSkillDocPath, type ExtractedTool } from './extract.js';
import { langOf } from './lexer.js';
import { detectPoisoning, type RuleHit } from './poisoning.js';

export type AiComponentAssetType = 'SKILL' | 'MCP' | 'PLUGIN';

export interface EngineInputFile {
  path: string;
  content: string;
}

export interface FindingLocation {
  path: string;
  line: number;
  excerpt: string;
  toolName?: string;
}

export interface AiComponentFindingDraft {
  ruleId: string;
  severity: AiRuleSeverity;
  riskCategory: string;
  title: string;
  description: string;
  remediation: string;
  filePath: string | null;
  line: number | null;
  locations: FindingLocation[];
  evidence: string;
  confidence: number;
  fingerprint: string;
  needsJudge: boolean;
  detail: Record<string, unknown>;
}

export interface EngineResult {
  findings: AiComponentFindingDraft[];
  tools: ExtractedTool[];
  scannedFiles: number;
  skippedFiles: Array<{ path: string; reason: string }>;
}

export const MAX_LOCATIONS_PER_FINDING = 20;
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = /\.(?:py|pyw|js|mjs|cjs|jsx|ts|mts|cts|tsx|sh|bash|zsh|ps1|md|mdx|markdown|txt|rst|json|ya?ml|toml|ini|cfg|env|lock|pem|key)$/i;
const TEXT_NAME = /(?:^|\/)(?:dockerfile|makefile|procfile|requirements[^/]*\.txt|\.env(?:\.[\w-]+)?|\.npmrc|license)$/i;

export function isScannableTextPath(path: string): boolean {
  return TEXT_EXT.test(path) || TEXT_NAME.test(path);
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 规范化证据后算指纹：跨扫描稳定（忽略行号、空白与脱敏长度）；groupKey 为空时与旧指纹一致 */
function fingerprintOf(ruleId: string, path: string, excerpt: string, toolName?: string, groupKey?: string): string {
  const norm = excerpt.replace(/<MASKED(?::\d+)?>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return sha(`${ruleId}\u0000${path}\u0000${toolName ?? ''}\u0000${norm}${groupKey ? `\u0000${groupKey}` : ''}`).slice(0, 32);
}

const DECLARES = {
  exec: /\b(?:shell|command|commands|exec|subprocess|terminal|bash|script)\b|命令|脚本|终端|执行/iu,
  network: /\b(?:http|https|network|internet|api|upload|webhook|request|fetch|download)\b|网络|联网|接口|上传|下载|请求/iu,
  secrets: /\b(?:credential|secret|token|key|ssh|aws|env)\b|凭据|密钥|令牌|环境变量/iu,
};

function instructionMismatch(files: SourceFile[], hits: RuleHit[]): RuleHit[] {
  const docs = files.filter((f) => isSkillDocPath(f.path)).map((f) => f.content).join('\n');
  if (!docs) return [];
  const out: RuleHit[] = [];
  const pick = (ids: string[], declared: RegExp, what: string) => {
    if (declared.test(docs)) return;
    // 常量命令、测试代码里的命令不作为“说明与实现不一致”的依据
    const h = hits.find((x) => ids.includes(x.ruleId) && !isSkillDocPath(x.path) && x.meta?.argumentKind !== 'literal' && !isTestPath(x.path));
    if (h) out.push({ ...h, ruleId: 'skill.instruction_mismatch', excerpt: `说明文档未声明${what}，但实现中存在：${h.excerpt}`.slice(0, 400), confidence: 0.65 });
  };
  pick(['code.command_execution', 'code.command_injection', 'code.remote_code_execution', 'code.dynamic_execution', 'code.obfuscated_execution'], DECLARES.exec, '命令执行');
  pick(['code.data_exfiltration'], DECLARES.network, '网络外发');
  pick(['code.sensitive_file_access'], DECLARES.secrets, '凭据读取');
  return out;
}

const SEV_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
/** 未单独指定等级的命中按规则默认等级参与比较（混合常量/变量命令时取最高） */
function maxSeverity(list: RuleHit[], fallback: AiRuleSeverity): AiRuleSeverity {
  return list.map((h) => h.severity ?? fallback).reduce((a, b) => (SEV_RANK[b]! > SEV_RANK[a]! ? b : a));
}

/** 测试代码路径：tests/、test/、__tests__/、spec/ 目录，test_*.py、*_test.py、conftest.py、*.test|spec.(js|ts) */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
/** 测试代码中的命令执行不随组件运行，风险再降一级（低危保持低危） */
const TEST_DEMOTE_RULES = new Set(['code.command_execution', 'code.command_injection']);
const DEMOTE: Record<AiRuleSeverity, AiRuleSeverity> = { CRITICAL: 'HIGH', HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'LOW' };

function mergeHits(hits: RuleHit[]): AiComponentFindingDraft[] {
  const groups = new Map<string, RuleHit[]>();
  for (const h of hits) {
    const key = `${h.ruleId}\u0000${h.path}\u0000${h.toolName ?? ''}\u0000${h.groupKey ?? ''}`;
    const list = groups.get(key) ?? [];
    // 同一行同一规则只记一次
    if (!list.some((x) => x.line === h.line)) list.push(h);
    else {
      const prev = list.find((x) => x.line === h.line)!;
      prev.confidence = Math.max(prev.confidence ?? 0, h.confidence ?? 0) || undefined;
      prev.needsJudge = prev.needsJudge && h.needsJudge;
    }
    groups.set(key, list);
  }
  const drafts: AiComponentFindingDraft[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.line - b.line);
    const first = list[0]!;
    const def = aiAssetRule(first.ruleId);
    if (!def) continue;
    const locations = list.slice(0, MAX_LOCATIONS_PER_FINDING).map((h) => ({
      path: h.path,
      line: h.line,
      excerpt: redactLine(h.excerpt).slice(0, 400),
      ...(h.toolName ? { toolName: h.toolName } : {}),
    }));
    const confidence = Math.max(...list.map((h) => h.confidence ?? def.confidence));
    const needsJudge = list.every((h) => h.needsJudge === true);
    const inTest = TEST_DEMOTE_RULES.has(def.ruleId) && isTestPath(first.path);
    const baseSeverity: AiRuleSeverity = needsJudge && def.severity !== 'LOW' ? 'MEDIUM' : maxSeverity(list, def.severity);
    const meta: Record<string, unknown> = { ...(first.meta ?? {}) };
    // “参数为常量”只在该组全部命中都是常量命令时成立
    if (list.some((h) => h.meta?.argumentKind !== 'literal')) delete meta.argumentKind;
    drafts.push({
      ruleId: def.ruleId,
      severity: inTest ? DEMOTE[baseSeverity] : baseSeverity,
      riskCategory: def.riskCategory,
      title: `${def.title}${first.titleSuffix ?? ''}${first.toolName ? `（工具 ${first.toolName}）` : ''}`,
      description: def.description,
      remediation: def.remediation,
      filePath: first.path,
      line: first.line,
      locations,
      evidence: locations[0]!.excerpt,
      confidence: Number(confidence.toFixed(2)),
      fingerprint: fingerprintOf(def.ruleId, first.path, locations[0]!.excerpt, first.toolName, first.groupKey),
      needsJudge,
      detail: {
        v: 2,
        totalLocations: list.length,
        truncatedLocations: Math.max(0, list.length - MAX_LOCATIONS_PER_FINDING),
        taxonomy: taxonomyForAiAssetRule(def.ruleId),
        judge: needsJudge ? { status: 'PENDING' } : { status: 'NOT_NEEDED' },
        ...meta,
        ...(inTest ? { context: 'test' } : {}),
      },
    });
  }
  const order: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return drafts.sort((a, b) => (order[a.severity]! - order[b.severity]!) || (a.filePath ?? '').localeCompare(b.filePath ?? '') || (a.line ?? 0) - (b.line ?? 0));
}

/** 静态分析，不执行上传代码。附加的 extraHits（依赖漏洞、rug pull 等）由调用方计算后传入统一合并。 */
export function runAiComponentEngine(
  input: { assetType: AiComponentAssetType; files: EngineInputFile[] },
  extraHits: RuleHit[] = [],
): EngineResult {
  const skippedFiles: EngineResult['skippedFiles'] = [];
  const files: SourceFile[] = [];
  for (const f of input.files) {
    if (!isScannableTextPath(f.path)) {
      skippedFiles.push({ path: f.path, reason: '非文本/源码文件，未扫描' });
      continue;
    }
    if (Buffer.byteLength(f.content, 'utf8') > MAX_TEXT_FILE_BYTES) {
      skippedFiles.push({ path: f.path, reason: oversizeReason(MAX_TEXT_FILE_BYTES, '未扫描') });
      continue;
    }
    files.push({ path: f.path, content: f.content, lang: langOf(f.path) });
  }
  const { texts, tools } = extractModelFacing(files);
  const hits: RuleHit[] = [
    ...detectPoisoning(texts),
    ...detectCodeRisks(files),
    ...detectSecrets(files),
    ...detectUnauthenticatedListener(files),
    ...detectOverbroadPermissions(files),
    ...extraHits,
  ];
  if (input.assetType === 'SKILL' || input.assetType === 'PLUGIN') hits.push(...instructionMismatch(files, hits));
  return { findings: mergeHits(hits), tools, scannedFiles: files.length, skippedFiles };
}
