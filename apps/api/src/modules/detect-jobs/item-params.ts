import { DETECT_JOB_ITEM_META, isDetectJobItemKind, type DetectJobItemKind } from '@lse/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { tenantCondition } from '../../lib/detect-sql.js';
import { badRequest } from '../../lib/errors.js';
import { parseScanTargets } from '../asset-discovery/ranges.js';
import { evalPlanTemplateSchema } from '../eval-plans/service.js';
import { CHECK_CATALOG } from '../fleet-admin/check-catalog.js';
import { RULE_JUDGE_ENGINE, SENSITIVE_INFO_ENGINE } from '../eval-tasks/rule-judge.js';
import { checkQuestionSets } from '../question-sets/enabled.js';

// 组合任务、检测策略的子任务参数（2.4.9、2.4.3）。「规则选择」：评估选样本库，语料选规则集，体检选体检项。

const port = z.number().int().min(1).max(65535);
/** 内置引擎：规则判定、敏感信息（与前端 REQUIRED_ENGINES 一致）。 */
export const REQUIRED_EVAL_ENGINES = [RULE_JUDGE_ENGINE, SENSITIVE_INFO_ENGINE];
const POSTURE_ITEM_IDS = new Set(CHECK_CATALOG.posture.map((c) => c.id));

export const DETECT_JOB_ITEM_SCHEMAS = {
  /** 评估对象 + 样本库 + 引擎 + 维度 + 并发 + 抽样（与评估计划模板同一套校验）。 */
  eval_task: evalPlanTemplateSchema.extend({ modelTargetId: z.string().uuid() }),
  /** 服务器目录（要在允许目录内）或模型库里已上传完成的文件。 */
  model_file_scan: z.discriminatedUnion('source', [
    z
      .object({
        source: z.literal('directory'),
        path: z.string().trim().min(1).max(2000),
        targetId: z.string().uuid().optional(),
      })
      .strict(),
    z
      .object({
        source: z.literal('library'),
        uploadId: z.string().uuid(),
        targetId: z.string().uuid().optional(),
      })
      .strict(),
  ]),
  /** 重扫一次已上传的语料：复制原文件建新扫描。 */
  corpus_scan: z
    .object({
      sourceScanId: z.string().uuid(),
      ruleSetId: z.string().uuid().nullable().optional(),
      judgeReview: z.boolean().optional(),
    })
    .strict(),
  /**
   * confirm 必须为 true：页面上是「已获授权对目标主动探测」。
   * 与启动函数 startAssetDiscoveryRun 同一规则：目标写法要合法；有普通主机或网段（不是 URL、
   * 也不是「主机:端口」）时必须选端口。
   */
  asset_discovery: z
    .object({
      targets: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
      ports: z.array(port).max(16).default([]),
      confirm: z.literal(true),
    })
    .strict()
    .superRefine((value, ctx) => {
      let plain: number;
      try {
        plain = parseScanTargets(value.targets).plain.length;
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['targets'], message: (err as Error).message });
        return;
      }
      if (plain > 0 && value.ports.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['ports'], message: '请选择扫描端口' });
      }
    }),
  fleet_posture: z
    .object({
      endpointId: z.string().uuid(),
      items: z
        .array(z.string().refine((id) => POSTURE_ITEM_IDS.has(id), { message: '体检项不存在' }))
        .min(1)
        .optional(),
    })
    .strict(),
} satisfies Record<DetectJobItemKind, z.ZodTypeAny>;

export type DetectJobItemParams = {
  [K in DetectJobItemKind]: z.infer<(typeof DETECT_JOB_ITEM_SCHEMAS)[K]>;
};

function itemLabel(index: number | undefined): string {
  return index === undefined ? '子任务' : `第 ${index + 1} 项`;
}

/**
 * 校验一个子任务的参数。不合法抛 400 DETECT_JOB_ITEM_INVALID，提示里带子任务序号（index 从 0 起，提示从 1 起），
 * details 带 { index, kind, issues }（zod 的问题列表，方案清单据此列出缺的字段）。
 */
export function parseDetectJobItemParams<K extends DetectJobItemKind>(
  kind: K,
  params: unknown,
  index?: number,
): DetectJobItemParams[K] {
  if (!isDetectJobItemKind(kind)) {
    throw badRequest(`${itemLabel(index)}的检测类型不支持`, 'DETECT_JOB_ITEM_KIND_INVALID', {
      index,
      kind,
    });
  }
  const parsed = DETECT_JOB_ITEM_SCHEMAS[kind].safeParse(params ?? {});
  if (!parsed.success) {
    const has = (field: string) =>
      kind === 'asset_discovery' && parsed.error.issues.some((i) => i.path[0] === field);
    const reason = has('confirm')
      ? '需确认已获授权对目标主动探测'
      : has('ports')
        ? '请选择扫描端口'
        : '参数不完整或不合法';
    throw badRequest(
      `${itemLabel(index)}（${DETECT_JOB_ITEM_META[kind].label}）${reason}`,
      'DETECT_JOB_ITEM_INVALID',
      { index, kind, issues: parsed.error.issues },
    );
  }
  if (kind === 'eval_task') {
    // 规则判定、敏感信息是内置引擎，执行器总会跑；参数里也补上，和发起评估任务的页面一致。
    const p = parsed.data as DetectJobItemParams['eval_task'];
    return {
      ...p,
      engines: [...new Set([...REQUIRED_EVAL_ENGINES, ...(p.engines ?? [])])],
    } as DetectJobItemParams[K];
  }
  return parsed.data as DetectJobItemParams[K];
}

/**
 * 建组合任务、检测策略时检查子任务引用的对象在当前租户里存在（评估对象、样本库、模型库文件、
 * 来源语料扫描和规则集、终端）。其余检查（对象启用、目录在允许范围、原文件还在等）放到启动时。
 */
export async function assertDetectJobItemRefs<K extends DetectJobItemKind>(
  kind: K,
  params: DetectJobItemParams[K],
  index?: number,
): Promise<void> {
  const missing = (what: string) =>
    badRequest(
      `${itemLabel(index)}（${DETECT_JOB_ITEM_META[kind].label}）：${what}不存在`,
      'DETECT_JOB_ITEM_REF_NOT_FOUND',
      { index, kind },
    );
  const targetExists = async (id: string) =>
    Boolean(await prisma.modelTarget.findUnique({ where: { id }, select: { id: true } }));
  if (kind === 'eval_task') {
    const p = params as DetectJobItemParams['eval_task'];
    if (!(await targetExists(p.modelTargetId))) throw missing('评估对象');
    const check = await checkQuestionSets(prisma, p.questionSetIds);
    if (check.missing.length > 0) throw missing('样本库');
  } else if (kind === 'model_file_scan') {
    const p = params as DetectJobItemParams['model_file_scan'];
    if (p.targetId && !(await targetExists(p.targetId))) throw missing('评估对象');
    if (p.source === 'library') {
      const upload = await prisma.modelFileUpload.findFirst({
        where: { id: p.uploadId, status: { not: 'DELETED' } },
        select: { id: true },
      });
      if (!upload) throw missing('模型库文件');
    }
  } else if (kind === 'corpus_scan') {
    const p = params as DetectJobItemParams['corpus_scan'];
    const scan = await prisma.corpusScan.findFirst({
      where: { id: p.sourceScanId },
      select: { id: true },
    });
    if (!scan) throw missing('来源语料扫描');
    if (p.ruleSetId) {
      const set = await prisma.corpusRuleSet.findFirst({
        where: { id: p.ruleSetId },
        select: { id: true },
      });
      if (!set) throw missing('规则集');
    }
  } else if (kind === 'fleet_posture') {
    const p = params as DetectJobItemParams['fleet_posture'];
    const endpoint = await prisma.fleetEndpoint.findUnique({
      where: { id: p.endpointId },
      select: { id: true },
    });
    if (!endpoint) throw missing('终端');
  }
}

/**
 * 台账资产（检测方案线的 ledger_assets）在当前租户里是否存在。台账表还没建（本线没合入台账）时一律当作不存在。
 * 原始 SQL 不经租户扩展，带 tenantCondition。
 */
export async function ledgerAssetExists(id: string): Promise<boolean> {
  const [table] = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regclass('ledger_assets') IS NOT NULL AS ok`;
  if (!table?.ok) return false;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ledger_assets" WHERE "id" = ${id} ${tenantCondition('"tenantId"')} LIMIT 1`;
  return rows.length > 0;
}

/** 子任务关联的台账资产要在当前租户里存在，否则 400（提示带「第 N 项」）。 */
export async function assertLedgerAssetRef(
  kind: DetectJobItemKind,
  ledgerAssetId: string,
  index?: number,
): Promise<void> {
  if (await ledgerAssetExists(ledgerAssetId)) return;
  throw badRequest(
    `${itemLabel(index)}（${DETECT_JOB_ITEM_META[kind].label}）：台账资产不存在`,
    'DETECT_JOB_ITEM_REF_NOT_FOUND',
    { index, kind, field: 'ledgerAssetId' },
  );
}
