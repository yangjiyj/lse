import type { PrismaClient } from '@prisma/client';
import type { LlmTargetConfig } from '@lse/shared';
import { config } from '../../../config.js';
import { resolveServerTargetEgressContext } from '../../../lib/target-egress-policy.js';
import { asSystem } from '../../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../../lib/tenant-models.js';
import { RED_TEAM_SETTING_KEY } from '../../red-team/config.js';
import { selectLatestActiveJudgeTarget, type JudgeTargetStore } from '../../engines/judge-target.js';

export interface BankModel {
  cfg: LlmTargetConfig;
  /** 展示用的模型名（记录里的 generatorModel / judgeModel）。 */
  model: string;
}

export interface BankUpdateModels {
  generator: BankModel | null;
  judge: BankModel | null;
  /** 出题与核验是同一个模型。 */
  same: boolean;
}

/** 红队配置里的攻击模型（出题用）；没配置或未启用返回 null。 */
async function loadAttacker(db: PrismaClient): Promise<BankModel | null> {
  const setting = await db.systemSetting.findUnique({ where: { key: RED_TEAM_SETTING_KEY } });
  const id = String((setting?.value as Record<string, unknown> | null)?.attackerTargetId ?? '');
  if (!id) return null;
  // 攻击模型属于平台设置，系统任务没有租户范围，显式跨租户读。
  const t = await asSystem(async () => await db.modelTarget.findUnique({ where: { id } }));
  // 平台级任务只用平台的模型（共享的或平台租户自己的）：其他租户私有的攻击模型（含密钥）忽略，退回裁判模型。
  if (!t || !t.isActive || (t.tenantId !== null && t.tenantId !== PLATFORM_TENANT_ID)) return null;
  return {
    model: t.model,
    cfg: {
      baseUrl: t.baseUrl,
      apiKey: t.apiKey,
      model: t.model,
      extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
      defaultParams: (t.defaultParams as Record<string, unknown> | null) ?? null,
      egressContext: resolveServerTargetEgressContext(),
    },
  };
}

/** 裁判模型：最新启用的平台 JUDGE 模型（不取其他租户的）；没有就退回 LLM_JUDGE_* 环境变量。系统任务没有被测对象。 */
async function loadJudge(db: PrismaClient): Promise<BankModel | null> {
  const picked = await asSystem(
    async () => await selectLatestActiveJudgeTarget(db as unknown as JudgeTargetStore, { platformOnly: true }),
  );
  if (picked.target) {
    const t = picked.target;
    return {
      model: t.model,
      cfg: {
        baseUrl: t.baseUrl,
        apiKey: t.apiKey,
        model: t.model,
        extraHeaders: t.extraHeaders ?? null,
        defaultParams: t.defaultParams ?? null,
      },
    };
  }
  if (config.LLM_JUDGE_BASE_URL && config.LLM_JUDGE_API_KEY && config.LLM_JUDGE_MODEL) {
    return {
      model: config.LLM_JUDGE_MODEL,
      cfg: {
        baseUrl: config.LLM_JUDGE_BASE_URL,
        apiKey: config.LLM_JUDGE_API_KEY,
        model: config.LLM_JUDGE_MODEL,
      },
    };
  }
  return null;
}

/** 出题模型优先用红队配置的攻击模型，没有就用裁判模型；裁判模型见 loadJudge。 */
export async function resolveBankUpdateModels(db: PrismaClient): Promise<BankUpdateModels> {
  const judge = await loadJudge(db);
  const attacker = await loadAttacker(db);
  const generator = attacker ?? judge;
  const same = Boolean(
    generator && judge && generator.cfg.baseUrl === judge.cfg.baseUrl && generator.cfg.model === judge.cfg.model,
  );
  return { generator, judge, same };
}

export const NO_JUDGE_NOTE = '没有配置裁判模型，本次未更新';
