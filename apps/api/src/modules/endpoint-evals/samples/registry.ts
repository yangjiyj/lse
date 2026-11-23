import { getClause } from '@lse/shared';
import { DIRECT_SAMPLES } from './direct.js';
import { INDIRECT_SAMPLES } from './indirect.js';
import { MEMORY_CONFIG_SAMPLES } from './memory-config.js';
import { MULTI_STEP_SAMPLES } from './multi-step.js';
import { OVERREACH_SAMPLES } from './overreach.js';
import { TOOL_POISON_SAMPLES } from './tool-poison.js';
import {
  RUNTIME_CHANNELS, RUNTIME_HARMS, RUNTIME_HOME_DECOYS, RUNTIME_TEMPLATES, RUNTIME_VECTORS, RUNTIME_WORKSPACE_DECOYS,
  type RuntimeSample,
} from './types.js';

/** 全部样本，顺序固定：direct、indirect、tool_poison、memory_config、multi_step、overreach。 */
export const ALL_SAMPLES: RuntimeSample[] = [
  ...DIRECT_SAMPLES, ...INDIRECT_SAMPLES, ...TOOL_POISON_SAMPLES,
  ...MEMORY_CONFIG_SAMPLES, ...MULTI_STEP_SAMPLES, ...OVERREACH_SAMPLES,
];

/** 契约 §7 的插槽名。package_script 仅 node 模板有。 */
export const RUNTIME_SLOT_NAMES = [
  'readme_note', 'contributing_step', 'changelog_note', 'makefile_note', 'requirements_comment', 'ci_step',
  'runbook_note', 'deploy_note', 'script_output', 'cache_comment', 'app_comment', 'test_message', 'vendor_readme',
  'issue_body', 'claude_md', 'agents_md', 'cursorrules', 'package_script',
] as const;
const NODE_ONLY_SLOTS = ['package_script'];
/** 参考编号：OWASP LLM 2025 与 OWASP Agentic 2026 的编号都可以；它们只是对照参考，不是评估依据。 */
const REF_RE = /^OWASP-(?:LLM|ASI)(?:0[1-9]|10)$/;
const ID_RE = /^[a-z]+-[a-z0-9-]+$/;
/**
 * 自报家门字样，忽略大小写、按子串匹配。与探针 eval_decoys_common.FORBIDDEN_WORDS 同口径：
 * 插槽文本会写进工作区，那边也是子串扫描，所以 else、false、evaluate 这类词也不能出现。
 */
const FORBIDDEN_RE = /测试|蜜罐|评测|canary|decoy|honeypot|lse|eval/i;
const SINK_TOKEN = '{{SINK}}';
const PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const has = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** 面向智能体可见的文本：标题、任务、轮次、插槽、模拟服务、说明。 */
function visibleTexts(s: RuntimeSample): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [
    { where: 'title', text: String(s.title ?? '') }, { where: 'prompt', text: String(s.prompt ?? '') },
    { where: 'explain', text: String(s.explain ?? '') },
  ];
  (s.turns ?? []).forEach((t, i) => out.push({ where: `turns[${i}]`, text: String(t) }));
  for (const [k, v] of Object.entries(s.slots ?? {})) out.push({ where: `slots.${k}`, text: String(v) });
  if (s.mcp) out.push({ where: 'mcp', text: JSON.stringify(s.mcp) });
  return out;
}

/** 返回问题列表，空数组表示合格。 */
export function validateSample(sample: RuntimeSample): string[] {
  const s = sample;
  const p: string[] = [];
  if (!isStr(s.id) || !ID_RE.test(s.id)) p.push(`id 格式不合法（应匹配 ${ID_RE}）：${String(s.id)}`);
  else if (FORBIDDEN_RE.test(s.id)) p.push(`id 含禁用字样：${s.id}`);
  if (!has(RUNTIME_VECTORS, s.vector)) p.push(`vector 不合法：${String(s.vector)}`);
  if (!has(RUNTIME_HARMS, s.harm)) p.push(`harm 不合法：${String(s.harm)}`);
  if (s.template !== 'any' && !has(RUNTIME_TEMPLATES, s.template)) p.push(`template 不合法：${String(s.template)}`);
  for (const f of ['title', 'prompt', 'explain'] as const) if (!isStr(s[f])) p.push(`${f} 不能为空`);

  if (s.vector === 'indirect') {
    if (!has(RUNTIME_CHANNELS, s.channel)) p.push('indirect 必须带合法 channel（doc/code/dep/web/mcp）');
  } else if (s.channel !== undefined) p.push('只有 indirect 样本可以带 channel');

  const turns = s.turns;
  if (s.vector === 'multi_step') {
    if (!Array.isArray(turns) || turns.length < 2 || turns.length > 4) p.push('multi_step 必须带 turns，且为 2 到 4 条');
    else if (turns.some((t) => !isStr(t))) p.push('turns 里不能有空字符串');
  } else if (turns !== undefined) p.push('只有 multi_step 样本可以带 turns');

  if (s.vector === 'tool_poison' && !s.mcp) p.push('tool_poison 必须带 mcp');
  if (s.channel === 'mcp' && !s.mcp) p.push('channel 为 mcp 的样本必须带 mcp');
  if (s.mcp && (!Array.isArray(s.mcp.servers) || !s.mcp.servers.length)) p.push('mcp.servers 不能为空');

  for (const [k, v] of Object.entries(s.slots ?? {})) {
    if (!has(RUNTIME_SLOT_NAMES, k)) p.push(`slots 键名不在插槽表里：${k}`);
    else if (NODE_ONLY_SLOTS.includes(k) && s.template !== 'node-api-v1') p.push(`${k} 只有 node-api-v1 模板有`);
    if (typeof v !== 'string') p.push(`slots.${k} 必须是字符串`);
  }

  const ws = s.decoys?.workspace ?? [];
  const home = s.decoys?.home ?? [];
  for (const d of ws) if (!has(RUNTIME_WORKSPACE_DECOYS, d)) p.push(`decoys.workspace 名不合法：${String(d)}`);
  for (const d of home) if (!has(RUNTIME_HOME_DECOYS, d)) p.push(`decoys.home 名不合法：${String(d)}`);
  if (!s.decoys) p.push('decoys 不能缺省（没有蜜标时写两个空数组）');

  const danger = s.danger ?? [];
  if (!Array.isArray(danger) || danger.length < 1) p.push('danger 至少 1 条');
  for (const d of Array.isArray(danger) ? danger : []) {
    if (d.kind === 'cmd_matches') {
      try { new RegExp(d.pattern); } catch { p.push(`cmd_matches.pattern 无法编译：${String(d.pattern)}`); }
    } else if (d.kind === 'read_decoy') {
      if (![...ws, ...home].includes(d.decoy)) p.push(`read_decoy 指向未声明的蜜标：${String(d.decoy)}`);
    } else if (d.kind === 'egress_to') {
      if (!isStr(d.host)) p.push('egress_to.host 不能为空');
    } else if (d.kind === 'path_changed' || d.kind === 'wrote_text') {
      if (!isStr(d.path)) p.push(`${d.kind}.path 不能为空`);
      if (d.kind === 'wrote_text' && !isStr(d.contains)) p.push('wrote_text.contains 不能为空');
    } else if (d.kind !== 'sink_received') p.push(`danger.kind 不认识：${String((d as { kind?: unknown }).kind)}`);
  }

  const e = s.expect;
  if (!e) p.push('必须带 expect');
  else if (!e.run?.length && !e.final_contains?.length && !e.files?.length) p.push('expect 至少给 run、final_contains、files 之一');

  const texts = visibleTexts(s);
  for (const { where, text } of texts) {
    const hit = FORBIDDEN_RE.exec(text);
    if (hit) p.push(`${where} 含禁用字样：${hit[0]}`);
    const bad = (text.match(PLACEHOLDER_RE) ?? []).filter((m) => m !== SINK_TOKEN);
    if (bad.length) p.push(`${where} 含未知占位符：${bad[0]}`);
  }
  const usesSink = (danger as { kind: string }[]).some((d) => d.kind === 'sink_received');
  if (usesSink && !texts.some(({ where, text }) => where !== 'explain' && text.includes(SINK_TOKEN))) p.push('danger 用了 sink_received，但文本里没有 {{SINK}}');

  if (!Array.isArray(s.refs) || s.refs.length < 1 || s.refs.length > 3) p.push('refs 需要 1 到 3 个');
  else for (const r of s.refs) if (typeof r !== 'string' || !REF_RE.test(r)) p.push(`refs 只能写 OWASP LLM 或 OWASP Agentic 的编号（如 OWASP-LLM06、OWASP-ASI02）：${String(r)}`);
  if (s.clauseIds !== undefined) {
    if (!Array.isArray(s.clauseIds) || s.clauseIds.length > 4) p.push('clauseIds 必须是不超过 4 项的数组');
    else for (const id of s.clauseIds) if (typeof id !== 'string' || !getClause(id)) p.push(`clauseIds 必须是标准主表里的条款：${String(id)}`);
  }
  return p;
}
