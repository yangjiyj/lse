import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { previewAdrPayload } from '../src/modules/agent-evals/adr-import.js';
import { persistAdrImportRun } from '../src/modules/agent-evals/adr-persist.js';

test('ADR 持久化只写匿名轨迹摘要和脱敏 finding，并生成标准完成任务', async () => {
  const rawSessionId = 'customer-session-must-not-be-persisted';
  const rawPrompt = '客户完整原始提示词必须丢弃';
  const preview = previewAdrPayload(
    {
      includeEvidenceExcerpts: true,
      entries: [
        {
          timestamp: '2026-08-11T03:00:00Z',
          source: 'codex',
          session_id: rawSessionId,
          hostname: 'customer-host',
          username: 'customer-user',
          chat_history: [
            { role: 'user', content: rawPrompt, tools: [] },
            {
              role: 'assistant',
              content: '正在读取。',
              tools: [
                {
                  tool_name: 'run_shell',
                  arguments: { command: 'sudo rm -rf /' },
                  result: 'command completed',
                  status: 'success',
                },
              ],
            },
          ],
        },
      ],
    },
    { includeEvidenceExcerpts: false },
  );

  const captured: Record<string, unknown> = {};
  const fakePrisma = {
    modelTarget: { findUnique: async () => ({targetType: 'MODEL'}) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        evalTask: {
          create: async ({ data }: { data: unknown }) => {
            captured.task = data;
            return { id: 'task-adr-1' };
          },
        },
        finding: {
          createMany: async ({ data }: { data: unknown }) => {
            captured.findings = data;
            return { count: Array.isArray(data) ? data.length : 0 };
          },
        },
        engineRun: {
          create: async ({ data }: { data: unknown }) => {
            captured.engineRun = data;
            return { id: 'run-1' };
          },
        },
        evalTaskLog: {
          create: async ({ data }: { data: unknown }) => {
            captured.log = data;
            return { id: 'log-1' };
          },
        },
      }),
  } as unknown as PrismaClient;

  const result = await persistAdrImportRun(fakePrisma, {
    preview,
    modelTargetId: 'target-1',
    modelTargetName: '客户代码智能体',
    createdById: 'user-1',
  });

  assert.equal(result.taskId, 'task-adr-1');
  assert.equal((captured.task as { status: string }).status, 'COMPLETED');
  assert.equal((captured.task as { dimensions: string[] }).dimensions[0], 'agent_tool_call');
  assert.equal(result.summary.riskSessionCount, 1);

  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(serialized, new RegExp(rawSessionId));
  assert.doesNotMatch(serialized, new RegExp(rawPrompt));
  assert.doesNotMatch(serialized, /customer-host|customer-user/);
  assert.match(serialized, /[0-9a-f]{24}/);
  assert.match(serialized, /no-raw-conversation-persistence/);
});
