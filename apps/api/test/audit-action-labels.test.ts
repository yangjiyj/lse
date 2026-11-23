// 审计动作中文标签完整性：遍历 api/worker 源码写入的每个审计 action，断言操作日志页都有中文标签，
// 不会显示为「其他操作」或英文原样。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NAME = String.raw`[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+`;

/** 模板字符串拼出的 action：前缀 → 源码中可能的取值（新增模板必须在此登记，否则测试失败）。 */
const TEMPLATE_EXPANSIONS: Record<string, string[]> = {
  // policy-suggestions/routes.ts reviewBody.decision 的三个字面量
  'policy_suggestion.': ['accept', 'modify', 'reject'],
  'batch_evaluation.': ['start', 'pause', 'resume', 'cancel', 'retry-errors'],
  // lib/data-security.ts auditDownload：kind 由调用方传入，下方单独收集
  'download.': [],
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

function collectActions(): { actions: Map<string, string>; unknownTemplates: string[] } {
  const actions = new Map<string, string>();
  const unknownTemplates: string[] = [];
  const files = ['apps/api/src', 'apps/worker/src'].flatMap((d) => walk(path.join(ROOT, d)));
  const lit = new RegExp(`['"](${NAME})['"]`, 'g');
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      const m = /\baction:\s*(.+)$/.exec(line);
      if (m && !line.includes('remediationAction')) {
        const expr = m[1]!;
        for (const hit of expr.matchAll(lit)) actions.set(hit[1]!, rel);
        const tmpl = /^`([a-z_][a-z0-9_.]*)\$\{/.exec(expr);
        if (tmpl) {
          const prefix = tmpl[1]!;
          const values = TEMPLATE_EXPANSIONS[prefix];
          if (!values) unknownTemplates.push(`${rel}: ${prefix}\${…}`);
          else for (const v of values) actions.set(prefix + v, rel);
        }
      }
      const helper = new RegExp(String.raw`\baudit\(\s*\w+,\s*['"](${NAME})['"]`).exec(line);
      if (helper) actions.set(helper[1]!, rel);
    }
    for (const m of src.matchAll(/auditDownload\([\s\S]{0,200}?kind:\s*['"]([a-z_]+)['"]/g)) {
      actions.set(`download.${m[1]}`, rel);
    }
  }
  return { actions, unknownTemplates };
}

function webLabels(): Map<string, string> {
  const src = readFileSync(path.join(ROOT, 'apps/web/src/pages/AuditLogsPage.tsx'), 'utf8');
  const block = src.split('ACTION_LABELS: Record<string, string> = {')[1]!.split('\n};')[0]!;
  return new Map([...block.matchAll(/'([^']+)':\s*'([^']*)'/g)].map((m) => [m[1]!, m[2]!]));
}

test('提取器能找到已知的审计动作（防止正则失效后测试空转）', () => {
  const { actions } = collectActions();
  for (const a of [
    'auth.login',
    'eval_task.retest_failed',
    'eval_plan.enable',
    'eval_plan.disable',
    'model_file_scan.run',
    'policy_suggestion.reject',
    'download.standard_report_pdf',
  ]) {
    assert.ok(actions.has(a), `未提取到 ${a}`);
  }
  assert.ok(actions.size >= 100, `只提取到 ${actions.size} 个 action`);
});

test('模板拼接的审计动作都已登记可能取值', () => {
  assert.deepEqual(collectActions().unknownTemplates, []);
});

test('api/worker 写入的每个审计动作都有中文标签', () => {
  const labels = webLabels();
  const missing = [...collectActions().actions]
    .filter(([a]) => !labels.has(a))
    .map(([a, f]) => `${a}（${f}）`);
  assert.deepEqual(missing, [], `以下审计动作缺中文标签：\n${missing.join('\n')}`);
});

test('审计动作标签均为中文且不重复', () => {
  const labels = webLabels();
  const seen = new Map<string, string>();
  for (const [action, label] of labels) {
    assert.match(label, /[\u4e00-\u9fff]/, `${action} 的标签不含中文：${label}`);
    assert.notEqual(label, '其他操作', action);
    const dup = seen.get(label);
    assert.equal(dup, undefined, `${action} 与 ${dup} 标签重复：${label}`);
    seen.set(label, action);
  }
});
