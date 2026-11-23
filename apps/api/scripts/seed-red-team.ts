// 一次性 seed 脚本：在【隔离测试库】里建好红队种子题库 + 全局红队配置。
//
// 安全红线：
//   1. import 本模块不触发任何 DB 连接或落库——buildRedTeamSeedQuestions / RED_TEAM_QUESTION_SET
//      是纯数据，形状测试直接 import 它们。
//   2. 落库逻辑只在【脚本被直接执行】时由 main() 触发；模块顶层不构造 PrismaClient、不读 DATABASE_URL。
//   3. main() 第一步即校验 DATABASE_URL 指向测试库，否则抛错拒绝写入。
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';
import { RED_TEAM_SETTING_KEY } from '../src/modules/red-team/config.js';
import {
  buildRedTeamSeedPacks as buildBuiltinRedTeamSeedPacks,
  findObsoleteRedTeamQuestions,
  RED_TEAM_SEED_PACKS as BUILTIN_RED_TEAM_SEED_PACKS,
  type BuiltinRedTeamQuestionSeed,
} from '../src/modules/red-team/builtin-seeds.js';
import { redactString } from '../src/lib/redact.js';

export const RED_TEAM_SEED_PACKS = BUILTIN_RED_TEAM_SEED_PACKS;
export { findObsoleteRedTeamQuestions };
export const RED_TEAM_QUESTION_SET = {
  name: RED_TEAM_SEED_PACKS[0].name,
  type: 'SHOULD_REFUSE' as const,
  isBuiltin: true,
  language: 'zh',
  source: RED_TEAM_SEED_PACKS[0].source,
};

export interface RedTeamSettingValue {
  gatewayTargetId: string;
  attackerTargetId: string;
}

export type RedTeamSeedQuestion = BuiltinRedTeamQuestionSeed;

/** 构造内置红队种子题（4 道「应当拒答」的危险请求）。纯函数，不连库。 */
export function buildRedTeamSeedQuestions(
  gatewayTargetId: string,
  attackerTargetId: string,
): RedTeamSeedQuestion[] {
  return buildBuiltinRedTeamSeedPacks(gatewayTargetId, attackerTargetId)[0]!.questions;
}

export function buildRedTeamSeedPacks(gatewayTargetId: string, attackerTargetId: string) {
  return buildBuiltinRedTeamSeedPacks(gatewayTargetId, attackerTargetId);
}

/**
 * 全局红队配置（SystemSetting redteam.config）的 value。
 * 只写本次必须覆盖的双侧 target id；maxRounds / noProgressK / moves / budgetTokens
 * 等参数刻意不落库，运行时由 resolveRedTeamConfig 浅合并 DEFAULT_RED_TEAM_CONFIG 自动回落，
 * 避免把默认值钉死在库里（日后改默认才能自动生效）。
 */
export function buildRedTeamSettingValue(
  gatewayTargetId: string,
  attackerTargetId: string,
): RedTeamSettingValue {
  return { gatewayTargetId, attackerTargetId };
}

// ============================= 落库（仅直接执行时触发）=============================
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!/test|localhost|127\.0\.0\.1/.test(databaseUrl)) {
    throw new Error('拒绝向非测试库写种子');
  }

  const gatewayTargetId = process.env.RED_TEAM_GATEWAY_TARGET_ID ?? 'seed-gateway-target';
  const attackerTargetId = process.env.RED_TEAM_ATTACKER_TARGET_ID ?? 'seed-attacker-target';

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const packs = buildRedTeamSeedPacks(gatewayTargetId, attackerTargetId);
    for (const pack of packs) {
      await prisma.questionSet.create({
        data: {
          name: pack.name,
          type: pack.type,
          tags: pack.tags,
          language: pack.language,
          source: pack.source,
          isBuiltin: pack.isBuiltin,
          description: pack.description,
          questions: {
            create: pack.questions.map((q) => ({
              externalId: q.externalId,
              content: q.content,
              category: q.category,
              expectedBehavior: q.expectedBehavior,
              referenceAnswer: q.referenceAnswer,
              severity: q.severity,
              type: q.type,
              language: pack.language,
              shouldRefuse: q.shouldRefuse,
              tags: q.tags,
              metadata: q.metadata as unknown as Prisma.InputJsonValue,
            })),
          },
        },
      });
    }

    await prisma.systemSetting.upsert({
      where: { key: RED_TEAM_SETTING_KEY },
      create: {
        key: RED_TEAM_SETTING_KEY,
        value: buildRedTeamSettingValue(
          gatewayTargetId,
          attackerTargetId,
        ) as unknown as Prisma.InputJsonValue,
      },
      update: {
        value: buildRedTeamSettingValue(
          gatewayTargetId,
          attackerTargetId,
        ) as unknown as Prisma.InputJsonValue,
      },
    });

    const total = packs.reduce((sum, pack) => sum + pack.questions.length, 0);
    console.log(
      `[seed-red-team] 题集已创建：${packs.length} 个种子包，${total} 道种子题 + 全局 ${RED_TEAM_SETTING_KEY}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// 标准 ESM 守卫：仅当本文件被直接执行（而非被 import）时才落库。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // 失败信息可能裹挟连接串/凭据，落屏前先脱敏，绝不回显明文 key。
    console.error(redactString(String(err)));
    process.exitCode = 1;
  });
}
