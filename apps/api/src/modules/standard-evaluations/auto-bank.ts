import type { PrismaClient } from '@prisma/client';
import {
  STANDARD_GROUP_BANK,
  STANDARD_SAMPLING_ALGORITHM_VERSION,
  STANDARD_CORE_CATEGORIES,
  STANDARD_NON_REFUSAL_TOPICS,
  STANDARD_PROFILE_ID,
  STANDARD_PROFILE_VERSION,
  STANDARD_RISK_CATEGORIES,
  type StandardBankType,
  type StandardSampleGroup,
} from '@lse/shared';
import { Prisma } from '@prisma/client';
import { generate } from '../generator/core/generate.js';
import { makeRng } from '../generator/core/prng.js';
import { STANDARD_ATTACK_PATTERNS, STANDARD_NON_REFUSAL_PATTERNS } from './standard-patterns.js';
import { profileSnapshot, sha256 } from './core.js';

/**
 * 自动样本集：用平台内置的攻击样本生成器现产国标专项样本，
 * 不要求客户维护样本库。同一 seed 产出同一批样本，报告可复现。
 *
 * 覆盖度仍然如实计算并随发布版存档：抽样条数少于类别数时必然覆盖不全，
 * 缺口要出现在报告里而不是被掩盖。
 */

export interface AutoBankCounts {
  GENERATION_SAFETY: number;
  SHOULD_REFUSE: number;
  NON_REFUSAL: number;
}

export interface AutoBankCoverage {
  /** 实际产出条数（生成器容量不足时会少于请求数）。 */
  produced: AutoBankCounts;
  requested: AutoBankCounts;
  /** 命中的国标风险类别。 */
  coveredCategories: string[];
  /** 31 类中本次没有样本的类别。 */
  missingCategories: string[];
  /** 17 个核心类别中缺失的部分，报告里要单独点名。 */
  missingCoreCategories: string[];
  coveredTopics: string[];
  missingTopics: string[];
}

export interface BuiltBankRelease {
  releaseId: string;
  coverage: AutoBankCoverage;
  itemCount: number;
}

interface GeneratedRow {
  bankType: StandardBankType;
  content: string;
  expectedBehavior: string | null;
  category: string;
  primaryCategory: string | null;
  nonRefusalTopic: string | null;
  externalId: string;
}

/**
 * 按类别分层生成：先把配额均分到每个类别，余数按 seed 决定的顺序补给前几类。
 * 这样只要条数不少于类别数，就一定覆盖全部类别，而不是靠随机抽样碰运气。
 */
function allocateByCategory(
  categories: string[],
  count: number,
  seed: string,
): Map<string, number> {
  const allocation = new Map<string, number>();
  if (categories.length === 0 || count <= 0) return allocation;

  const base = Math.floor(count / categories.length);
  let remainder = count % categories.length;
  // 条数少于类别数时，用 seed 决定这一轮抽中哪几个类别，保证同 seed 可复现。
  const order = makeRng(`${seed}:allocation`).shuffle(categories);

  for (const category of order) {
    let quota = base;
    if (remainder > 0) {
      quota += 1;
      remainder -= 1;
    }
    if (quota > 0) allocation.set(category, quota);
  }
  return allocation;
}

function generateRows(bankType: StandardBankType, count: number, seed: string): GeneratedRow[] {
  if (count <= 0) return [];
  // 生成类与应拒答两个库都从攻击模板出，非拒答库从对照模板出。
  const patterns =
    bankType === 'NON_REFUSAL' ? STANDARD_NON_REFUSAL_PATTERNS : STANDARD_ATTACK_PATTERNS;
  const types = [...new Set(patterns.map((pattern) => pattern.type))];
  const categories = [...new Set(patterns.map((pattern) => pattern.category))].sort();
  const allocation = allocateByCategory(categories, count, `${seed}:${bankType}`);

  const rows: GeneratedRow[] = [];
  for (const [category, quota] of allocation) {
    const outcome = generate(patterns, {
      types,
      categories: [category],
      language: 'zh',
      count: quota,
      seed: `${seed}:${bankType}:${category}`,
      dedupe: true,
    });
    for (const question of outcome.questions) {
      rows.push({
        bankType,
        content: question.content,
        expectedBehavior: question.expectedBehavior,
        category: question.category,
        // 国标模板的 category 直接就是风险类别键 / 非拒答主题，无需再映射。
        primaryCategory: bankType === 'NON_REFUSAL' ? null : question.category,
        nonRefusalTopic: bankType === 'NON_REFUSAL' ? question.category : null,
        externalId: question.externalId,
      });
    }
  }
  return rows;
}

export async function buildGeneratedBankRelease(
  prisma: PrismaClient,
  options: {
    seed: string;
    counts: AutoBankCounts;
    createdById: string | null;
    name?: string;
    /** 自动样本集所属租户（平台发布的标准题集为空，各租户可用）。 */
    tenantId?: string | null;
  },
): Promise<BuiltBankRelease> {
  const { seed, counts, createdById, tenantId } = options;

  const rows: GeneratedRow[] = [
    // 生成类安全：诱导模型产出有害内容的样本。
    ...generateRows('GENERATION_SAFETY', counts.GENERATION_SAFETY, seed),
    // 应拒答：明确应当被拒绝的请求。
    ...generateRows('SHOULD_REFUSE', counts.SHOULD_REFUSE, seed),
    // 非拒答对照：正常问题，用来测误拒。
    ...generateRows('NON_REFUSAL', counts.NON_REFUSAL, seed),
  ];

  if (rows.length === 0) {
    throw new Error('攻击样本生成器没有产出任何样本，无法组建国标样本集');
  }

  const produced: AutoBankCounts = {
    GENERATION_SAFETY: rows.filter((row) => row.bankType === 'GENERATION_SAFETY').length,
    SHOULD_REFUSE: rows.filter((row) => row.bankType === 'SHOULD_REFUSE').length,
    NON_REFUSAL: rows.filter((row) => row.bankType === 'NON_REFUSAL').length,
  };
  const coveredCategories = [
    ...new Set(rows.map((row) => row.primaryCategory).filter((v): v is string => Boolean(v))),
  ].sort();
  const coveredTopics = [
    ...new Set(rows.map((row) => row.nonRefusalTopic).filter((v): v is string => Boolean(v))),
  ].sort();
  const missingCategories = STANDARD_RISK_CATEGORIES.filter(
    (category) => !coveredCategories.includes(category),
  );
  const coverage: AutoBankCoverage = {
    produced,
    requested: counts,
    coveredCategories,
    missingCategories: [...missingCategories],
    missingCoreCategories: STANDARD_CORE_CATEGORIES.filter(
      (category) => !coveredCategories.includes(category),
    ),
    coveredTopics,
    missingTopics: STANDARD_NON_REFUSAL_TOPICS.filter((topic) => !coveredTopics.includes(topic)),
  };

  const releaseName = options.name ?? `平台自动生成样本集 ${seed}`;
  const overallHash = sha256({
    seed,
    counts,
    contents: rows.map((row) => row.content),
  });

  return prisma.$transaction(async (tx) => {
    const release = await tx.standardBankRelease.create({
      data: {
        // 任务自动样本集只属于建任务的那个租户，不能出现在别家的样本集列表里。
        tenantId: tenantId ?? null,
        profileId: STANDARD_PROFILE_ID,
        profileVersion: STANDARD_PROFILE_VERSION,
        name: releaseName,
        language: 'zh',
        modalities: ['text'],
        status: 'PUBLISHED',
        counts: produced as unknown as object,
        // 自动样本集不走人工建库与评审，覆盖度如实存档供报告引用。
        validation: {
          ok: true,
          fixtureOnly: false,
          generated: true,
          seed,
          coverage: coverage as unknown as object,
          warnings: coverage.missingCoreCategories.length
            ? [
                `本样本集未覆盖 ${coverage.missingCoreCategories.length} 个国标核心风险类别，` +
                  `结论仅覆盖已抽样范围。`,
              ]
            : [],
        } as unknown as object,
        overallHash,
        publishedAt: new Date(),
        publishedById: createdById,
      },
    });

    const positions = new Map<StandardBankType, number>();
    for (const row of rows) {
      const revision = await tx.standardQuestionRevision.create({
        data: {
          version: 1,
          content: row.content,
          expectedBehavior: row.expectedBehavior,
          category: row.category,
          primaryCategory: row.primaryCategory,
          secondaryCategories: [],
          nonRefusalTopic: row.nonRefusalTopic,
          language: 'zh',
          modality: 'text',
          purpose: 'GB/T 45654 输出安全符合性抽样',
          source: `generator:${row.externalId}`,
          standardProfileId: STANDARD_PROFILE_ID,
          standardProfileVersion: STANDARD_PROFILE_VERSION,
          contentHash: sha256({ content: row.content }),
          createdById,
        },
      });
      const position = (positions.get(row.bankType) ?? 0) + 1;
      positions.set(row.bankType, position);
      await tx.standardBankReleaseItem.create({
        data: {
          releaseId: release.id,
          revisionId: revision.id,
          bankType: row.bankType,
          primaryCategory: row.primaryCategory,
          nonRefusalTopic: row.nonRefusalTopic,
          position,
        },
      });
    }

    return { releaseId: release.id, coverage, itemCount: rows.length };
  });
}

/**
 * 按生成位置抽样。共享的 sampleStandardItems 以 item.id（uuid）排序，
 * 自动样本集每次新建、uuid 每次不同，同一 seed 就抽不出同一批样本。
 * position 由生成顺序决定，与 seed 一一对应，因此跨样本集也能复现。
 */
function pickByPosition<T extends { position: number }>(
  items: readonly T[],
  count: number,
  seed: string,
): T[] {
  const pool = [...items].sort((a, b) => a.position - b.position);
  const rng = makeRng(seed);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const current = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = current;
  }
  return pool.slice(0, count);
}

/** 每组的抽样配额。人工与技术两组共用同一批生成类攻击样本。 */
export type StandardGroupCounts = Record<StandardSampleGroup, number>;

export interface AttachedStandardRun {
  runId: string;
  releaseId: string;
  sampleCount: number;
  selectedCounts: Record<string, number>;
  samplePlanHash: string;
  coverage: AutoBankCoverage;
}

/**
 * 给一条已存在的评估任务挂上国标符合性运行：现场生成攻击样本、冻结抽样名单。
 * 不调用被测模型 —— 执行仍然由队列里的国标执行器负责。
 */
export async function attachStandardComplianceRun(
  prisma: PrismaClient,
  options: {
    taskId: string;
    modelTarget: { id: string; name: string; provider: string; model: string; targetType: string };
    seed: string;
    groupCounts: StandardGroupCounts;
    createdById: string | null;
    /** 任务所属租户：自动样本集跟着任务走。 */
    tenantId?: string | null;
  },
): Promise<AttachedStandardRun> {
  const { taskId, modelTarget, seed, groupCounts, createdById, tenantId } = options;

  // 生成池：两个安全组共用生成类样本，取两者的最大配额即可满足各自抽样。
  const poolCounts: AutoBankCounts = {
    GENERATION_SAFETY: Math.max(groupCounts.MANUAL_SAFETY, groupCounts.TECHNICAL_SAFETY),
    SHOULD_REFUSE: groupCounts.SHOULD_REFUSE,
    NON_REFUSAL: groupCounts.NON_REFUSAL,
  };
  const built = await buildGeneratedBankRelease(prisma, {
    seed,
    counts: poolCounts,
    createdById,
    tenantId,
    name: `任务自动样本集 ${seed}`,
  });

  // 抽样输入必须有确定顺序，否则同一 seed 抽不出同一批样本，报告就不可复现。
  const items = await prisma.standardBankReleaseItem.findMany({
    where: { releaseId: built.releaseId },
    include: { revision: true },
    orderBy: [{ bankType: 'asc' }, { position: 'asc' }],
  });

  const selected: Array<{ group: StandardSampleGroup; item: (typeof items)[number] }> = [];
  const selectedCounts: Record<string, number> = {};
  for (const group of Object.keys(groupCounts) as StandardSampleGroup[]) {
    const bankType = STANDARD_GROUP_BANK[group];
    const candidates = items.filter((item) => item.bankType === bankType);
    const take = Math.min(groupCounts[group], candidates.length);
    selectedCounts[group] = take;
    if (take === 0) continue;
    selected.push(
      ...pickByPosition(candidates, take, `${seed}:${group}`).map((item) => ({ group, item })),
    );
  }

  if (selected.length === 0) {
    throw new Error('国标符合性抽样为空：生成器没有产出可用样本');
  }

  const plan = {
    ...groupCounts,
    seed,
    mode: 'TASK_EMBEDDED',
    algorithm: STANDARD_SAMPLING_ALGORITHM_VERSION,
    selectedCounts,
    generated: true,
    coverage: built.coverage,
    generatedAt: new Date().toISOString(),
  };
  const planHash = sha256({
    seed,
    counts: groupCounts,
    algorithm: STANDARD_SAMPLING_ALGORITHM_VERSION,
  });

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.standardRun.create({
      data: {
        taskId,
        bankReleaseId: built.releaseId,
        profileSnapshot: profileSnapshot() as Prisma.InputJsonValue,
        modelSnapshot: {
          id: modelTarget.id,
          name: modelTarget.name,
          provider: modelTarget.provider,
          model: modelTarget.model,
          targetType: modelTarget.targetType,
        } as Prisma.InputJsonValue,
        boundary: 'MODEL_API',
        language: 'zh',
        modality: 'text',
        samplePlan: plan as unknown as Prisma.InputJsonValue,
        samplePlanHash: planHash,
        createdById,
      },
    });
    const sequenceByGroup = new Map<StandardSampleGroup, number>();
    await tx.standardSample.createMany({
      data: selected.map((selection) => {
        const sequence = (sequenceByGroup.get(selection.group) ?? 0) + 1;
        sequenceByGroup.set(selection.group, sequence);
        return {
          standardRunId: created.id,
          group: selection.group,
          sequence,
          revisionId: selection.item.revisionId,
          releaseItemId: selection.item.id,
          inputSnapshot: selection.item.revision.content,
          expectedBehavior: selection.item.revision.expectedBehavior,
          primaryCategory: selection.item.primaryCategory,
          nonRefusalTopic: selection.item.nonRefusalTopic,
        };
      }),
    });
    return created;
  });

  return {
    runId: run.id,
    releaseId: built.releaseId,
    sampleCount: selected.length,
    selectedCounts,
    samplePlanHash: planHash,
    coverage: built.coverage,
  };
}
