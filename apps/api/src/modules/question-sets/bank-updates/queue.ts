import { Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { config } from '../../../config.js';
import { writeAudit } from '../../../lib/audit.js';
import { getRedisConnection } from '../../../lib/queue.js';
import { PLATFORM_TENANT_ID } from '../../../lib/tenant-models.js';
import { asSystem } from '../../../lib/tenant-context.js';
import { BANK_UPDATE_TZ, KEYWORD_CRON, QUESTION_BANK_CRON } from './constants.js';
import { runKeywordUpdate, type KeywordUpdateDeps } from './keywords-job.js';
import { finalizeStaleRuns, isBankUpdateRunning } from './run-state.js';
import { runQuestionBankUpdate, type QuestionUpdateDeps } from './questions-job.js';

export const BANK_UPDATE_QUEUE_NAME = 'gbt-bank-updates';
export const BANK_UPDATE_JOB_NAME = 'run';
export const SYSTEM_ACTOR_NAME = '系统定时任务';

export type BankUpdateKind = 'questions' | 'keywords';

export interface BankUpdateJobData {
  kind: BankUpdateKind;
  trigger: 'schedule' | 'manual';
  /** 手动触发时的操作人。 */
  actorName?: string;
}

const isTest = process.env.LSE_TEST === '1' || config.NODE_ENV === 'test';

let queue: Queue<BankUpdateJobData> | null = null;

export function getBankUpdateQueue(): Queue<BankUpdateJobData> {
  if (!queue) queue = new Queue<BankUpdateJobData>(BANK_UPDATE_QUEUE_NAME, { connection: getRedisConnection() });
  return queue;
}

export async function closeBankUpdateQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const BANK_UPDATE_SCHEDULER_IDS = {
  questions: 'gbt-bank-questions-monthly',
  keywords: 'gbt-bank-keywords-weekly',
} as const;

/** 注册两个定时任务：题库每月 1 日 03:00，关键词每周一 03:00（上海时区）。幂等。 */
export async function registerBankUpdateSchedulers(q: Queue<BankUpdateJobData> = getBankUpdateQueue()): Promise<void> {
  const opts = { removeOnComplete: 50, removeOnFail: 100, attempts: 1 };
  await q.upsertJobScheduler(
    BANK_UPDATE_SCHEDULER_IDS.questions,
    { pattern: QUESTION_BANK_CRON, tz: BANK_UPDATE_TZ },
    { name: BANK_UPDATE_JOB_NAME, data: { kind: 'questions', trigger: 'schedule' }, opts },
  );
  await q.upsertJobScheduler(
    BANK_UPDATE_SCHEDULER_IDS.keywords,
    { pattern: KEYWORD_CRON, tz: BANK_UPDATE_TZ },
    { name: BANK_UPDATE_JOB_NAME, data: { kind: 'keywords', trigger: 'schedule' }, opts },
  );
}

/**
 * worker 启动时调用：自动更新开启（BANK_AUTO_UPDATE_ENABLED=true）才注册定时；
 * 关闭时（默认）把以前注册过的两个定时连同排好的下一次一起移除。
 */
export async function syncBankUpdateSchedulers(
  enabled: boolean = config.BANK_AUTO_UPDATE_ENABLED,
  q: Queue<BankUpdateJobData> = getBankUpdateQueue(),
): Promise<'registered' | 'removed'> {
  if (enabled) {
    await registerBankUpdateSchedulers(q);
    return 'registered';
  }
  await q.removeJobScheduler(BANK_UPDATE_SCHEDULER_IDS.questions);
  await q.removeJobScheduler(BANK_UPDATE_SCHEDULER_IDS.keywords);
  return 'removed';
}

export { isBankUpdateRunning };

export interface BankUpdateJobDeps {
  /** 自动更新是否开启；不传按 BANK_AUTO_UPDATE_ENABLED。关闭时定时触发的任务直接跳过。 */
  autoUpdateEnabled?: boolean;
  question?: Partial<QuestionUpdateDeps>;
  keyword?: Partial<KeywordUpdateDeps>;
}

export type BankUpdateJobResult = {
  status: 'succeeded' | 'failed' | 'skipped';
  reason?: string;
  id?: string;
  version?: string;
};

/** job 处理函数：系统任务，跨租户读平台配置；同类已在执行就不重复跑；执行完写审计。 */
export async function processBankUpdateJob(
  db: PrismaClient,
  data: BankUpdateJobData,
  deps: BankUpdateJobDeps = {},
  jobId?: string | null,
): Promise<BankUpdateJobResult> {
  // 自动更新关闭时，队列里残留的定时任务不执行（也不留记录）。
  if (data.trigger === 'schedule' && !(deps.autoUpdateEnabled ?? config.BANK_AUTO_UPDATE_ENABLED)) {
    return { status: 'skipped', reason: '自动更新未开启' };
  }
  const actorName = data.trigger === 'schedule' ? SYSTEM_ACTOR_NAME : (data.actorName ?? SYSTEM_ACTOR_NAME);
  return asSystem(async () => {
    // 已中断的执行中记录（心跳过期，或本任务被杀后重投回来时留下的）先收尾成失败，再照常执行。
    await finalizeStaleRuns(db, data.kind, { jobId });
    if (await isBankUpdateRunning(db, data.kind)) return { status: 'skipped', reason: '同类更新正在执行' };
    const result =
      data.kind === 'questions'
        ? await runQuestionBankUpdate(db, { trigger: data.trigger, actorName, jobId, ...deps.question })
        : await runKeywordUpdate(db, { trigger: data.trigger, actorName, jobId, ...deps.keyword });
    await writeAudit({
      actorId: null,
      actorName,
      action: data.kind === 'questions' ? 'question_set.bank_update' : 'question_set.keyword_update',
      tenantId: PLATFORM_TENANT_ID,
      targetType: 'question_set',
      targetId: 'gbt45654',
      detail: {
        trigger: data.trigger,
        status: result.status,
        version: result.version,
        added: result.added,
        error: result.error,
      },
    });
    return { status: result.status, id: result.id, version: result.version };
  });
}

export function createBankUpdateWorker(db: PrismaClient): Worker<BankUpdateJobData> {
  // 启动时把上次被中断（心跳过期）的执行中记录收尾，页面不再一直显示「执行中」。
  void asSystem(async () => await finalizeStaleRuns(db)).catch((e: unknown) =>
    console.error('[worker] 题库更新遗留记录收尾失败:', (e as Error).message),
  );
  return new Worker<BankUpdateJobData>(BANK_UPDATE_QUEUE_NAME, async (job) => processBankUpdateJob(db, job.data, {}, job.id), {
    connection: getRedisConnection(),
    concurrency: 1,
  });
}

/** 立即执行一次：加入队列。测试环境（LSE_TEST=1）不连 Redis，什么都不做（测试注入自己的执行函数）。 */
export async function enqueueBankUpdate(data: BankUpdateJobData): Promise<void> {
  if (isTest) return;
  await getBankUpdateQueue().add(BANK_UPDATE_JOB_NAME, data, { removeOnComplete: 50, removeOnFail: 100, attempts: 1 });
}

/** 队列里是否已有同类等待或执行中的任务（测试环境恒为 false）。 */
/**
 * 队列里是否已有同类的手动更新在排队或执行。定时任务会预先放一个「下次执行」的延时任务（trigger=schedule），
 * 不能把它当成「正在进行」，否则「立即更新」永远点不动；定时任务真正执行时库里有 running 记录，由 isBankUpdateRunning 拦。
 */
export function hasPendingManualJob(jobs: ReadonlyArray<{ data: BankUpdateJobData } | undefined>, kind: BankUpdateKind): boolean {
  return jobs.some((j) => j?.data?.kind === kind && j.data.trigger === 'manual');
}

/** 等待或执行中的同类任务不论手动、定时都算；延时任务只算手动的（定时任务预放的「下次执行」不算）。 */
export function hasQueuedJob(
  live: ReadonlyArray<{ data: BankUpdateJobData } | undefined>,
  delayed: ReadonlyArray<{ data: BankUpdateJobData } | undefined>,
  kind: BankUpdateKind,
): boolean {
  return live.some((j) => j?.data?.kind === kind) || hasPendingManualJob(delayed, kind);
}

export async function hasPendingBankUpdate(kind: BankUpdateKind): Promise<boolean> {
  if (isTest) return false;
  const q = getBankUpdateQueue();
  const [live, delayed] = await Promise.all([q.getJobs(['waiting', 'active', 'prioritized']), q.getJobs(['delayed'])]);
  return hasQueuedJob(live, delayed, kind);
}
