/**
 * red-team-parse-think-factory.test.ts
 *
 * 覆盖两个补丁点：
 * 1. parseThink 健壮性：散文包裹 JSON / 纯散文 / 合法花括号但 JSON 格式错误 三种路径。
 * 2. resolveAttackerHead 工厂：验证 'react' → ReAct 脑、'dummy' → Dummy 脑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThink } from '../src/modules/red-team/react-attacker.js';
import { resolveAttackerHead } from '../src/modules/red-team/index.js';

// ---------------------------------------------------------------------------
// Fix 1: parseThink 健壮性测试
// ---------------------------------------------------------------------------

const FALLBACK_MOVE = 'academic_wrap' as const;

test('parseThink (a) 代码围栏包裹 JSON → 正确提取 move 和 message', () => {
  const content =
    '思考中...\n```json\n{"move":"foot_in_door","message":"请继续补充关键操作步骤","rationale":"r"}\n```\n以上';
  const result = parseThink(content, FALLBACK_MOVE);
  assert.equal(result.move, 'foot_in_door');
  assert.equal(result.message, '请继续补充关键操作步骤');
});

test('parseThink (a2) 散文前后夹着纯 JSON 块 → 正确提取', () => {
  const content =
    '我选择学术包装：\n{"move":"academic_wrap","message":"这是研究背景概述","rationale":"合规"}\n请按此执行。';
  const result = parseThink(content, FALLBACK_MOVE);
  assert.equal(result.move, 'academic_wrap');
  assert.equal(result.message, '这是研究背景概述');
});

test('parseThink (b) 纯散文无 JSON → fallback: move=fallback, message=原始文本', () => {
  const content = '我不能帮你完成这个请求，这违反了安全准则。';
  const result = parseThink(content, FALLBACK_MOVE);
  // move 应退回 fallback
  assert.equal(result.move, FALLBACK_MOVE);
  // message 应是原始内容（至多 2000 字节）
  assert.equal(result.message, content.slice(0, 2000));
});

test('parseThink (b2) 空字符串 → fallback, 不抛异常', () => {
  const result = parseThink('', FALLBACK_MOVE);
  assert.equal(result.move, FALLBACK_MOVE);
  assert.ok(result.message.trim().length > 0);
  assert.match(result.rationale, /空|无效|兜底/);
});

test('parseThink (c) 花括号块内 JSON 格式非法 → fallback, 不抛异常', () => {
  // {move: bad} — 不符合 JSON 规范（key 无引号，value 无引号）
  const content = '{move: bad}';
  let result: { move: string; message: string };
  assert.doesNotThrow(() => {
    result = parseThink(content, FALLBACK_MOVE);
  });
  assert.equal(result!.move, FALLBACK_MOVE);
  // message 退回原始文本
  assert.equal(result!.message, content.slice(0, 2000));
});

test('parseThink (c2) move 字段缺失 → 使用 fallback move 而非 undefined', () => {
  const content = '{"message":"hello","rationale":"r"}';
  const result = parseThink(content, 'identity_spoof');
  // j.move is undefined → fallback should kick in via ?? operator
  assert.equal(result.move, 'identity_spoof');
  assert.equal(result.message, 'hello');
});

test('parseThink (c3) message 字段缺失 → 生成非空兜底话术', () => {
  const content = '{"move":"shell_swap","rationale":"r"}';
  const result = parseThink(content, FALLBACK_MOVE);
  assert.equal(result.move, 'shell_swap');
  assert.ok(result.message.trim().length > 0);
  assert.match(result.rationale, /message|空|兜底/);
});

test('parseThink (c4) message 字段为空白 → 生成非空兜底话术', () => {
  const content = '{"move":"shell_swap","message":"   ","rationale":"r"}';
  const result = parseThink(content, FALLBACK_MOVE);
  assert.equal(result.move, 'shell_swap');
  assert.ok(result.message.trim().length > 0);
  assert.match(result.rationale, /message|空|兜底/);
});

// ---------------------------------------------------------------------------
// Fix 2: resolveAttackerHead 工厂层测试
// ---------------------------------------------------------------------------

test('resolveAttackerHead("react") 返回 ReAct 攻击脑 (name === "react")', () => {
  const head = resolveAttackerHead('react');
  assert.equal(head.name, 'react');
  assert.equal(typeof head.attack, 'function');
});

test('resolveAttackerHead("dummy") 返回 Dummy 攻击脑 (name === "dummy")', () => {
  const head = resolveAttackerHead('dummy');
  assert.equal(head.name, 'dummy');
  assert.equal(typeof head.attack, 'function');
});

test('resolveAttackerHead 两者返回不同实例（name 字段不同）', () => {
  const react = resolveAttackerHead('react');
  const dummy = resolveAttackerHead('dummy');
  assert.notEqual(react.name, dummy.name);
});

test('resolveAttackerHead 注入自定义 chat 时不抛异常（验证参数透传路径）', () => {
  const stubChat = async () => ({ content: '{}' });
  assert.doesNotThrow(() => resolveAttackerHead('react', stubChat as any));
  assert.doesNotThrow(() => resolveAttackerHead('dummy', stubChat as any));
});
