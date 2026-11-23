import type { Prisma, PrismaClient } from '@prisma/client';
import { generateMcpScenarios } from './generator.js';
import { BUILTIN_MCP_ATTACK_PACK, BUILTIN_MCP_ATTACK_PACK_VERSION } from './packs/builtin.js';

export function builtinMcpQuestionSetSource(): string {
  return `builtin:mcp:${BUILTIN_MCP_ATTACK_PACK_VERSION}`;
}
/** Append a versioned set. Keep old versions and any manually added questions intact. */
export async function syncBuiltinMcpQuestions(db: Pick<PrismaClient, 'questionSet' | 'question'>) {
  const source = builtinMcpQuestionSetSource();
  let set = await db.questionSet.findFirst({ where: { source, isBuiltin: true } });
  if (!set) {
    set = await db.questionSet.create({
      data: {
        name: 'MCP 专项样本（含本地检测器自检）',
        source,
        type: 'PROMPT_INJECTION',
        isBuiltin: true,
        tags: ['builtin', 'mcp', BUILTIN_MCP_ATTACK_PACK_VERSION],
        metadata: {
          packId: BUILTIN_MCP_ATTACK_PACK.id,
          packVersion: BUILTIN_MCP_ATTACK_PACK_VERSION,
        },
      },
    });
  }
  const existing = await db.question.findMany({
    where: { questionSetId: set.id },
    select: { externalId: true },
  });
  const ids = new Set(existing.map((question) => question.externalId));
  const missing = generateMcpScenarios({
    sampleCount: BUILTIN_MCP_ATTACK_PACK.templates.length,
    seed: 'builtin-mcp-seed',
  }).filter((scenario) => !ids.has(scenario.externalId));
  if (missing.length) {
    await db.question.createMany({
      data: missing.map((scenario) => ({
        questionSetId: set.id,
        content: scenario.prompt,
        type: scenario.type,
        category: scenario.category,
        language: scenario.language,
        severity: scenario.severity,
        shouldRefuse: scenario.shouldRefuse,
        expectedBehavior: scenario.expectedBehavior,
        referenceAnswer: scenario.referenceAnswer,
        tags: scenario.tags,
        externalId: scenario.externalId,
        metadata: scenario.metadata as unknown as Prisma.InputJsonValue,
      })),
    });
  }
  return { setId: set.id, added: missing.length, version: BUILTIN_MCP_ATTACK_PACK_VERSION };
}
