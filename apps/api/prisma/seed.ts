import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { PERMISSIONS, ROLE_DEFS } from '@lse/shared';
import {
  buildBuiltinQuestionSetSeed,
  findMissingBuiltinQuestions,
} from '../src/modules/benchmarks/builtin-seed.js';
import {
  buildRedTeamSeedPacks,
  findObsoleteRedTeamQuestions,
} from '../src/modules/red-team/builtin-seeds.js';
import { syncBuiltinMcpQuestions } from '../src/modules/agent-evals/builtin-seed.js';
import { resolveAdminCredentials } from '../src/lib/admin-credentials.js';
import { syncBuiltinComplianceSets } from '../src/modules/question-sets/builtin/seed.js';
import { syncBuiltinDatasetSets } from '../src/modules/question-sets/builtin/dataset.js';
import { loadManifest, syncGbt45654Banks } from '../src/modules/question-sets/builtin/gbt45654-bank.js';
import { recordBankReleases } from '../src/modules/question-sets/bank-updates/bank-meta.js';
import { syncBuiltinKeywords } from '../src/modules/keyword-library/seed.js';
import { ensureBuiltinTools } from '../src/modules/tools/builtin-seed.js';

const prisma = new PrismaClient();

async function migrateDeprecatedSuperAdminRole(adminRoleId: string): Promise<void> {
  const deprecated = await prisma.role.findUnique({
    where: { name: 'super_admin' },
    select: { id: true },
  });
  if (!deprecated) return;

  const memberships = await prisma.userRole.findMany({
    where: { roleId: deprecated.id },
    select: { userId: true },
  });

  await prisma.$transaction([
    ...memberships.map(({ userId }) =>
      prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: adminRoleId } },
        create: { userId, roleId: adminRoleId },
        update: {},
      }),
    ),
    prisma.userRole.deleteMany({ where: { roleId: deprecated.id } }),
    prisma.rolePermission.deleteMany({ where: { roleId: deprecated.id } }),
    prisma.role.delete({ where: { id: deprecated.id } }),
  ]);
  console.log(`[seed] 已迁移旧 super_admin 角色到 admin（${memberships.length} 个用户）`);
}

async function main(): Promise<void> {
  // 1) 权限目录
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, group: p.group },
      update: { name: p.name, group: p.group },
    });
  }

  // 2) 内置角色 + 权限绑定（每次 seed 都把内置角色重置为权威权限集）
  for (const def of ROLE_DEFS) {
    const role = await prisma.role.upsert({
      where: { name: def.name },
      create: { name: def.name, description: def.description, isBuiltin: def.isBuiltin },
      update: { description: def.description, isBuiltin: def.isBuiltin },
    });
    const perms = await prisma.permission.findMany({
      where: { code: { in: def.permissions } },
      select: { id: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: perms.map((perm) => ({ roleId: role.id, permissionId: perm.id })),
      skipDuplicates: true,
    });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  await migrateDeprecatedSuperAdminRole(adminRole.id);

  // 3) 内置管理员账号（已存在则不覆盖密码）
  //    仅首次创建管理员时解析 ADMIN_PASSWORD；老库部署仍会同步权限/题集，但不会要求重设初始口令。
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const existing = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
  let passwordSource: 'env' | 'dev-default' | 'existing' = 'existing';
  if (!existing) {
    const credentials = resolveAdminCredentials();
    passwordSource = credentials.passwordSource;
    const passwordHash = await argon2.hash(credentials.password, { type: argon2.argon2id });
    await prisma.user.create({
      data: {
        username: credentials.username,
        passwordHash,
        displayName: credentials.displayName,
        isBuiltin: true,
        isActive: true,
        roles: { create: { roleId: adminRole.id } },
      },
    });
  } else {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: existing.id, roleId: adminRole.id } },
      create: { userId: existing.id, roleId: adminRole.id },
      update: {},
    });
  }

  // 4) 开箱即用：内置 CC0 安全评估样例集（幂等同步，按 source 定位题集）
  //    让任何部署登录后「问题集管理」里都有一个现成可用题集；后续内置样本增加时，
  //    seed 会只补齐缺失题目，不删除用户数据，也不重复插入既有题。
  const builtin = buildBuiltinQuestionSetSeed();
  const existedBuiltin = await prisma.questionSet.findFirst({
    where: { source: builtin.source },
    select: { id: true },
  });
  const questionData = (setId: string, q: (typeof builtin.questions)[number]) => ({
    questionSetId: setId,
    externalId: q.externalId,
    content: q.content,
    category: q.category,
    expectedBehavior: q.expectedBehavior,
    referenceAnswer: q.referenceAnswer,
    type: q.type,
    severity: q.severity,
    shouldRefuse: q.shouldRefuse,
    language: q.language,
    tags: q.tags,
  });
  if (!existedBuiltin) {
    const createdSet = await prisma.questionSet.create({
      data: {
        name: builtin.name,
        description: builtin.description,
        type: builtin.type,
        tags: builtin.tags,
        source: builtin.source,
        isBuiltin: builtin.isBuiltin,
      },
    });
    await prisma.question.createMany({
      data: builtin.questions.map((q) => questionData(createdSet.id, q)),
    });
    console.log(`[seed] 内置题集已入库：${builtin.name}（${builtin.questions.length} 题）`);
  } else {
    await prisma.questionSet.update({
      where: { id: existedBuiltin.id },
      data: {
        name: builtin.name,
        description: builtin.description,
        type: builtin.type,
        tags: builtin.tags,
        isBuiltin: builtin.isBuiltin,
      },
    });
    const existingQuestions = await prisma.question.findMany({
      where: { questionSetId: existedBuiltin.id },
      select: { externalId: true, content: true, type: true },
    });
    const missingQuestions = findMissingBuiltinQuestions(builtin.questions, existingQuestions);
    if (missingQuestions.length > 0) {
      await prisma.question.createMany({
        data: missingQuestions.map((q) => questionData(existedBuiltin.id, q)),
      });
    }
    console.log(`[seed] 内置题集已同步：${builtin.name}（补充 ${missingQuestions.length} 题）`);
  }

  // 4.1) 内置合规题库（TC260 / 信通院 / 能源行业）：按 source + externalId 幂等补齐。
  for (const r of await syncBuiltinComplianceSets(prisma)) {
    console.log(
      `[seed] 内置合规题库已同步：${r.source}（${r.created ? '新建' : '已存在'}，补充 ${r.added} 题）`,
    );
  }

  // 4.2) 内置开源数据集题库（Safety-Prompts，Apache-2.0，约 10 万题）：按 source + externalId 幂等补齐。
  for (const r of await syncBuiltinDatasetSets(prisma)) {
    console.log(
      `[seed] 内置数据集题库已同步：${r.source}（${r.created ? '新建' : '已存在'}，共 ${r.total} 题，补充 ${r.added} 题）`,
    );
  }

  // 4.3) GB/T 45654-2025 附录 B 固定题库（生成内容 / 应拒答 / 非拒答）与起步关键词库：
  //      按 source + externalId 幂等补齐；数据文件带版本与 sha256，载入时校验。
  for (const r of await syncGbt45654Banks(prisma)) {
    console.log(
      `[seed] 国标题库已同步：${r.source}（${r.created ? '新建' : '已存在'}，共 ${r.total} 题，补充 ${r.added} 题，下线旧题 ${r.retired} 题）`,
    );
  }
  const kw = await syncBuiltinKeywords(prisma);
  console.log(`[seed] 国标关键词库已同步：共 ${kw.total} 个内置词，补充 ${kw.added} 个（生效），剔除版本里已没有的词 ${kw.rejected} 个，恢复 ${kw.restored} 个，候选改生效 ${kw.promoted} 个，并入每周更新词 ${kw.adopted} 个`);
  // 版本发布记录：manifest 的题库与关键词版本还没有对应的 release 记录就补一条（幂等）。
  const rel = await recordBankReleases(
    prisma,
    loadManifest(),
    await prisma.standardKeyword.count({ where: { tenantId: null, reviewStatus: { not: 'rejected' } } }),
  );
  if (rel.questions || rel.keywords) console.log(`[seed] 已补写版本发布记录：题库 ${rel.questions ? '是' : '否'}，关键词 ${rel.keywords ? '是' : '否'}`);

  // 5) 内置自主红队种子包：冒烟 / 标准 / 深度。这里不写具体 target id，
  //    发起任务时会按客户选择的被测模型、攻击脑和裁判模型写入任务专用样本。
  const redTeamPacks = buildRedTeamSeedPacks();
  for (const pack of redTeamPacks) {
    let existedPack = await prisma.questionSet.findFirst({
      where: { source: pack.source },
      select: { id: true },
    });
    const redTeamQuestionData = (setId: string, q: (typeof pack.questions)[number]) => ({
      questionSetId: setId,
      externalId: q.externalId,
      content: q.content,
      category: q.category,
      expectedBehavior: q.expectedBehavior,
      referenceAnswer: q.referenceAnswer,
      type: q.type,
      severity: q.severity,
      shouldRefuse: q.shouldRefuse,
      language: q.language,
      tags: q.tags,
      metadata: q.metadata,
    });
    const createRedTeamPack = async () => {
      const createdSet = await prisma.questionSet.create({
        data: {
          name: pack.name,
          description: pack.description,
          type: pack.type,
          tags: pack.tags,
          source: pack.source,
          language: pack.language,
          isBuiltin: pack.isBuiltin,
        },
      });
      await prisma.question.createMany({
        data: pack.questions.map((q) => redTeamQuestionData(createdSet.id, q)),
      });
      return createdSet;
    };
    if (!existedPack) {
      await createRedTeamPack();
      console.log(`[seed] 内置红队种子包已入库：${pack.name}（${pack.questions.length} 题）`);
    } else {
      const existingQuestions = await prisma.question.findMany({
        where: { questionSetId: existedPack.id },
        select: { id: true, externalId: true, content: true, type: true },
      });
      const obsoleteQuestions = findObsoleteRedTeamQuestions(pack.questions, existingQuestions);
      let archivedQuestionCount = 0;
      let activeQuestions: Pick<
        (typeof existingQuestions)[number],
        'externalId' | 'content' | 'type'
      >[] = existingQuestions;

      if (obsoleteQuestions.length > 0) {
        const obsoleteIds = obsoleteQuestions.map((q) => q.id);
        const referencedCount = await prisma.evalResult.count({
          where: { questionId: { in: obsoleteIds } },
        });
        if (referencedCount > 0) {
          await prisma.questionSet.update({
            where: { id: existedPack.id },
            data: {
              name: `${pack.name}（历史保留）`,
              source: `legacy:${pack.source}:${existedPack.id}`,
              isBuiltin: true,
            },
          });
          archivedQuestionCount = existingQuestions.length;
          existedPack = await createRedTeamPack();
          activeQuestions = pack.questions;
        } else {
          await prisma.question.deleteMany({ where: { id: { in: obsoleteIds } } });
          archivedQuestionCount = obsoleteQuestions.length;
          activeQuestions = existingQuestions.filter((q) => !obsoleteIds.includes(q.id));
        }
      }

      await prisma.questionSet.update({
        where: { id: existedPack.id },
        data: {
          name: pack.name,
          description: pack.description,
          type: pack.type,
          tags: pack.tags,
          language: pack.language,
          isBuiltin: pack.isBuiltin,
        },
      });
      const missingQuestions = findMissingBuiltinQuestions(pack.questions, activeQuestions);
      if (missingQuestions.length > 0) {
        await prisma.question.createMany({
          data: missingQuestions.map((q) => redTeamQuestionData(existedPack.id, q)),
        });
      }
      console.log(
        `[seed] 内置红队种子包已同步：${pack.name}（归档 ${archivedQuestionCount} 题，补充 ${missingQuestions.length} 题）`,
      );
    }
  }

  // 工具中心的内置工具（终端探针）：只建缺失的，不覆盖管理员改过的说明。
  await ensureBuiltinTools(prisma);

  const mcpSync = await syncBuiltinMcpQuestions(prisma);
  console.log(
    `[seed] MCP版本已同步：${mcpSync.version}（补充 ${mcpSync.added} 题；保留旧版与人工题）`,
  );

  const [permCount, roleCount, setCount] = await Promise.all([
    prisma.permission.count(),
    prisma.role.count(),
    prisma.questionSet.count(),
  ]);
  const passwordSourceLabel =
    passwordSource === 'env'
      ? '环境变量'
      : passwordSource === 'existing'
        ? '沿用已有账号'
        : '开发默认口令，请尽快修改';
  console.log(
    `[seed] permissions=${permCount} roles=${roleCount} questionSets=${setCount} admin=${ADMIN_USERNAME} (口令来源: ${passwordSourceLabel})`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
