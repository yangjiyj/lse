import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { groupWrongAnswers, groupDetail, type RiskSample } from '../src/modules/wrong-answers/groups.js';

const base = (id: string, tenantId: string, targetName: string): RiskSample => ({
  id, taskId: `task-${tenantId}`, tenantId, questionContent: '题目', riskCategory: 'data_exfiltration', severity: 'HIGH',
  question: { metadata: { sourceQuestionId: '原题' } }, createdAt: '2026-11-01T00:00:00Z', targetName,
});
const rows = [base('s1', 'tenant-A', '甲对象'), base('s2', 'tenant-B', '乙对象'), base('s3', 'tenant-A', '甲对象')];

test('全部租户视角：同一风险身份按租户拆成各自的问题，互不混入', () => {
  const groups = groupWrongAnswers(rows, { byTenant: true });
  assert.equal(groups.length, 2);
  const a = groups.find(g => g.tenantId === 'tenant-A')!;
  const b = groups.find(g => g.tenantId === 'tenant-B')!;
  assert.deepEqual(a.targets.names, ['甲对象']);
  assert.equal(a.sampleCount, 2);
  assert.deepEqual(b.targets.names, ['乙对象']);
  assert.equal(b.sampleCount, 1);
  assert.notEqual(a.id, b.id);
  const da = groupDetail(rows, a.id, 1, 20, { byTenant: true })!;
  const db = groupDetail(rows, b.id, 1, 20, { byTenant: true })!;
  assert.deepEqual([...da.members.items].sort(), ['s1', 's3']);
  assert.deepEqual(db.members.items, ['s2']);
  assert.equal(da.tenantId, 'tenant-A');
  assert.equal(db.tenantId, 'tenant-B');
  // 不带选项时找不到按租户拆分后的 id
  assert.equal(groupDetail(rows, a.id), null);
});

test('默认（单租户）分组与组 id 不变，仍按旧算法合并', () => {
  const groups = groupWrongAnswers(rows);
  assert.equal(groups.length, 1);
  const oldId = createHash('sha256').update('source:sourceQuestionId:原题').digest('hex').slice(0, 24);
  assert.equal(groups[0]!.id, oldId);
  assert.equal(groupWrongAnswers(rows, { byTenant: false })[0]!.id, oldId);
  assert.equal(groupDetail(rows, oldId)!.members.total, 3);
  // 单租户数据开启 byTenant 只改 id，不改分组数量
  assert.equal(groupWrongAnswers(rows.filter(r => r.tenantId === 'tenant-A'), { byTenant: true }).length, 1);
});
