// 审计对象类型中文标签完整性：遍历 api/worker 源码写入的每个审计 targetType（以及前端查看明文时上报的
// targetType），断言操作日志页都有中文标签并出现在对象类型筛选中，不会显示为「其他对象」。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p, exts);
    return exts.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function collectTargetTypes(): Map<string, string> {
  const types = new Map<string, string>();
  // 后端：审计写入里的 targetType 字面量。全大写的是 Prisma TargetType 枚举（评估对象类型，用于查询条件），不是审计对象类型。
  for (const file of ['apps/api/src', 'apps/worker/src'].flatMap((d) =>
    walk(path.join(ROOT, d), ['.ts']),
  )) {
    const rel = path.relative(ROOT, file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\btargetType:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
      if (!/^[A-Z_]+$/.test(m[1]!)) types.set(m[1]!, rel);
    }
    // model-files/routes.ts 的 audit(req, action, targetType, ...) 辅助函数
    for (const m of src.matchAll(/\baudit\(\s*\w+,\s*'[^']+',\s*'([a-z_]+)'/g))
      types.set(m[1]!, rel);
  }
  // 前端：SensitiveText 查看明文经 /data-security/reveal 以 targetType 写审计
  for (const file of walk(path.join(ROOT, 'apps/web/src'), ['.tsx'])) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\btargetType="([a-z_]+)"/g))
      types.set(m[1]!, path.relative(ROOT, file));
  }
  return types;
}

function webTargetTypeLabels(): Map<string, string> {
  const src = readFileSync(path.join(ROOT, 'apps/web/src/pages/AuditLogsPage.tsx'), 'utf8');
  const block = src.split('TARGET_TYPE_LABELS: Record<string, string> = {')[1]!.split('\n};')[0]!;
  return new Map(
    [...block.matchAll(/^\s*'?([A-Za-z_][A-Za-z0-9_]*)'?:\s*'([^']*)'/gm)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}

test('提取器能找到已知的审计对象类型（防止正则失效后测试空转）', () => {
  const types = collectTargetTypes();
  for (const t of [
    'eval_task',
    'policy_suggestion',
    'model_file_scan',
    'standard_run',
    'eval_result',
  ]) {
    assert.ok(types.has(t), `未提取到 ${t}`);
  }
  assert.ok(!types.has('JUDGE'), 'TargetType 枚举值不应被当作审计对象类型');
  assert.ok(types.size >= 30, `只提取到 ${types.size} 个 targetType`);
});

test('api/worker 写入的每个审计对象类型都有中文标签', () => {
  const labels = webTargetTypeLabels();
  const missing = [...collectTargetTypes()]
    .filter(([t]) => !labels.has(t))
    .map(([t, f]) => `${t}（${f}）`);
  assert.deepEqual(missing, [], `以下审计对象类型缺中文标签：\n${missing.join('\n')}`);
});

test('对象类型标签均为中文且不重复', () => {
  const seen = new Map<string, string>();
  for (const [type, label] of webTargetTypeLabels()) {
    assert.match(label, /[\u4e00-\u9fff]/, `${type} 的标签不含中文：${label}`);
    assert.notEqual(label, '其他对象', type);
    const dup = seen.get(label);
    assert.equal(dup, undefined, `${type} 与 ${dup} 标签重复：${label}`);
    seen.set(label, type);
  }
});

test('对象类型筛选下拉框覆盖全部标签', () => {
  const src = readFileSync(path.join(ROOT, 'apps/web/src/pages/AuditLogsPage.tsx'), 'utf8');
  assert.match(src, /const TARGET_TYPE_OPTIONS = Object\.keys\(TARGET_TYPE_LABELS\);/);
});
