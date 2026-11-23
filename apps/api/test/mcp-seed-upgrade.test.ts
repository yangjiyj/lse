import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prisma } from '../src/db.js';
import { builtinMcpQuestionSetSource } from '../src/modules/agent-evals/builtin-seed.js';
import { BUILTIN_MCP_ATTACK_PACK_VERSION } from '../src/modules/agent-evals/packs/builtin.js';
test('真实prisma db seed升级保留旧版与人工题，新版自检题入库且再次seed不重复', async () => {
  const id = randomUUID();
  await prisma.questionSet.create({
    data: {
      id,
      name: '合成MCP旧版升级测试',
      type: 'PROMPT_INJECTION',
      tags: [],
      isBuiltin: true,
      source: `builtin:mcp:old-test-${id}`,
      questions: {
        create: {
          content: '合成旧题不得丢失',
          type: 'PROMPT_INJECTION',
          shouldRefuse: true,
          tags: [],
          externalId: 'old-item',
          metadata: { attackPackVersion: 'builtin-mcp-attacks@2026-07-02.1' },
        },
      },
    },
  });
  try {
    const seed = () => {
      const run = spawnSync(
        'nice',
        ['-n', '19', 'corepack', 'pnpm', 'exec', 'prisma', 'db', 'seed'],
        { cwd: new URL('../../..', import.meta.url), env: process.env, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, 'prisma db seed退出码必须为0');
    };
    seed();
    const current = await prisma.questionSet.findFirstOrThrow({
      where: { source: builtinMcpQuestionSetSource() },
      include: { questions: true },
    });
    const sandbox = current.questions.filter((q) =>
      (q.metadata as any)?.templateId?.endsWith('-r4'),
    );
    assert.equal(sandbox.length, 8);
    assert.ok(
      sandbox.every(
        (q) => (q.metadata as any).attackPackVersion === BUILTIN_MCP_ATTACK_PACK_VERSION,
      ),
    );
    assert.ok(sandbox.every((q) => q.content.includes('本地沙箱探针（检测器自检）')));
    const marker = await prisma.question.create({
      data: {
        questionSetId: current.id,
        content: '合成人工保留题',
        type: 'GENERAL',
        tags: [],
        externalId: 'manual-upgrade-' + id,
      },
    });
    try {
      seed();
      assert.equal(
        await prisma.question.count({ where: { questionSetId: current.id } }),
        current.questions.length + 1,
      );
      assert.equal(
        await prisma.question.count({ where: { questionSetId: id, externalId: 'old-item' } }),
        1,
      );
      assert.equal(await prisma.question.count({ where: { id: marker.id } }), 1);
    } finally {
      await prisma.question.delete({ where: { id: marker.id } });
    }
  } finally {
    await prisma.question.deleteMany({ where: { questionSetId: id } });
    await prisma.questionSet.delete({ where: { id } });
  }
});
