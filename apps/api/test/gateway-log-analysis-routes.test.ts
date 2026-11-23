import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const PREFIX = '__gwlog_';
let app!: FastifyInstance;
let token = '';
let targetId = '';
let fakeServer!: http.Server;
let controlPlaneBaseUrl = '';
let seenTenant = '';
let seenAuth = '';
let originalAllowlist: string | undefined;

function auth(): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function listEvent(id: string, verdict: string, securityEventCount: number) {
  return {
    id,
    request_id: `req-${id}`,
    created_at: '2026-06-10T01:00:00Z',
    correlation: { trace_id: `trace-${id}` },
    source: { tenant_id: 'tenant-a', session_id: 'agent-session-1' },
    target: { model: 'glm-5', endpoint_type: 'chat_completions' },
    metrics: { status: 'completed', status_code: 200, latency_ms: 123 },
    action: verdict === 'blocked' ? 'block' : verdict === 'passed' ? 'allow' : 'alert',
    verdict,
    risk_level: verdict === 'passed' ? 'low' : 'high',
    policy_hits: [],
    evidence: { redacted: true, security_event_count: securityEventCount },
  };
}

async function cleanup(): Promise<void> {
  await prisma.evalTask.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.modelTarget.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

before(async () => {
  originalAllowlist = process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  process.env.NEWAPI_EVAL_INTEGRATION_TOKEN = 'internal-secret';

  fakeServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/admin/v1/eval-integration/audit-events?')) {
      seenTenant = String(req.headers['x-newapi-tenant-id'] ?? '');
      seenAuth = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [listEvent('risk-1', 'flagged', 1), listEvent('pass-1', 'passed', 0)],
          total: 2,
          next_cursor: '',
          has_more: false,
        }),
      );
      return;
    }
    if (req.url?.startsWith('/admin/v1/eval-integration/audit-events/risk-1')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            ...listEvent('risk-1', 'blocked', 1),
            risk_level: 'critical',
            policy_hits: [
              {
                event_id: 'sec-1',
                event_type: 'prompt_guard',
                severity: 'critical',
                action: 'block',
                category: 'prompt_injection',
                rule_id: 'pg-001',
                rule_name: '系统提示词泄露',
                evidence: '命中提示词泄露规则',
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = fakeServer.address() as AddressInfo;
  controlPlaneBaseUrl = `http://127.0.0.1:${addr.port}/admin/v1`;
  process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = new URL(controlPlaneBaseUrl).origin;

  app = await buildApp();
  await app.ready();
  await cleanup();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'Admin@12345' },
  });
  assert.equal(login.statusCode, 200, login.body);
  token = login.json().token;

  const target = await prisma.modelTarget.create({
    data: {
      name: `${PREFIX}智能体网关日志源`,
      targetType: 'GATEWAY_LOG',
      provider: 'newapi-agent-security-gateway',
      baseUrl: controlPlaneBaseUrl,
      apiKey: '',
      model: 'gateway-log-source',
      accessConfig: { controlPlaneBaseUrl, tenantId: 'tenant-a' },
    },
  });
  targetId = target.id;
});

after(async () => {
  await cleanup();
  await app.close();
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
  if (originalAllowlist === undefined) {
    delete process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST;
  } else {
    process.env.GATEWAY_CONTROL_PLANE_ALLOWLIST = originalAllowlist;
  }
  await prisma.$disconnect();
});

test('POST /api/gateway-logs/analyze creates an eval task from gateway traffic risks', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway-logs/analyze',
    headers: auth(),
    payload: {
      modelTargetId: targetId,
      name: `${PREFIX}网关日志分析任务`,
      startTime: '2026-06-10T00:00:00Z',
      endTime: '2026-06-10T02:00:00Z',
      limit: 50,
    },
  });

  assert.equal(res.statusCode, 201, res.body);
  assert.equal(seenTenant, 'tenant-a');
  assert.equal(seenAuth, 'Bearer internal-secret');
  const body = res.json();
  assert.equal(body.summary.totalEvents, 2);
  assert.equal(body.summary.riskEvents, 1);
  assert.equal(body.summary.blockedEvents, 1);

  const task = await prisma.evalTask.findUniqueOrThrow({ where: { id: body.task.id } });
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.totalQuestions, 2);
  assert.equal(task.processedQuestions, 2);
  assert.equal(task.passedCount, 1);
  assert.equal(task.failedCount, 1);
  assert.deepEqual(task.engines, ['newapi-agent-security-gateway']);
  assert.deepEqual(task.dimensions, ['gateway_traffic_log']);

  const findings = await prisma.finding.findMany({ where: { taskId: task.id } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.engine, 'newapi-agent-security-gateway');
  assert.equal(findings[0]?.riskCategory, 'prompt_injection');
  assert.equal(findings[0]?.severity, 'CRITICAL');
  assert.match(findings[0]?.evidence ?? '', /命中提示词泄露规则/);
  assert.equal((findings[0]?.detail as { requestId?: string }).requestId, 'req-risk-1');

  const engineRun = await prisma.engineRun.findFirstOrThrow({ where: { taskId: task.id } });
  assert.equal(engineRun.status, 'SUCCESS');
  assert.equal(engineRun.normalizedCount, 1);
});

test('GET /api/eval-tasks/:id/findings returns task-level gateway findings', async () => {
  const analyze = await app.inject({
    method: 'POST',
    url: '/api/gateway-logs/analyze',
    headers: auth(),
    payload: {
      modelTargetId: targetId,
      name: `${PREFIX}网关任务findings读取`,
      startTime: '2026-06-10T00:00:00Z',
      endTime: '2026-06-10T02:00:00Z',
      limit: 50,
    },
  });
  assert.equal(analyze.statusCode, 201, analyze.body);
  const taskId = analyze.json().task.id as string;

  const res = await app.inject({
    method: 'GET',
    url: `/api/eval-tasks/${taskId}/findings`,
    headers: auth(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 20);
  assert.equal(body.items.length, 1);

  const finding = body.items[0];
  assert.equal(typeof finding.id, 'string');
  assert.equal(typeof finding.createdAt, 'string');
  assert.equal(finding.engine, 'newapi-agent-security-gateway');
  assert.equal(finding.riskCategory, 'prompt_injection');
  assert.equal(finding.severity, 'CRITICAL');
  assert.equal(finding.verdict, 'FAIL');
  assert.match(finding.title ?? '', /系统提示词泄露/);
  assert.match(finding.evidence ?? '', /命中提示词泄露规则/);
  assert.equal((finding.detail as { requestId?: string }).requestId, 'req-risk-1');
  assert.equal((finding.detail as { gatewayAction?: string }).gatewayAction, 'block');
});

test('GET /api/eval-tasks/:id/findings returns 404 for unknown task', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/eval-tasks/00000000-0000-0000-0000-000000000000/findings',
    headers: auth(),
  });
  assert.equal(res.statusCode, 404, res.body);
});
