import { Redis } from 'ioredis';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { config } from '../config.js';

export const EVAL_QUEUE_NAME = 'eval-tasks';
export const BATCH_EVALUATION_QUEUE_NAME = 'batch-evaluations';
export const EVAL_TASK_CANCEL_TTL_SECONDS = 60 * 60;
export const EVAL_TASK_PAUSE_TTL_SECONDS = 60 * 60;
export const SERVICE_ASSURANCE_QUEUE_NAME = 'service-assurance';
export const SERVICE_ASSURANCE_CANCEL_TTL_SECONDS = 60 * 60;

export interface EvalJobData {
  taskId: string;
}

export interface ServiceAssuranceJobData {
  runId: string;
}

const isTest = process.env.LSE_TEST === '1' || config.NODE_ENV === 'test';

let redisConnection: Redis | null = null;
let evalQueue: Queue<EvalJobData> | null = null;
let batchEvaluationQueue: Queue<{ planId: string }> | null = null;

export function getBatchEvaluationQueue() {
  if (!batchEvaluationQueue) {
    batchEvaluationQueue = new Queue<{ planId: string }>(BATCH_EVALUATION_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return batchEvaluationQueue;
}

export async function enqueueBatchEvaluation(planId: string): Promise<void> {
  if (isTest) return;
  await getBatchEvaluationQueue().add(
    'run',
    { planId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  );
}
let serviceAssuranceQueue: Queue<ServiceAssuranceJobData> | null = null;

/** 懒加载 Redis 连接（BullMQ 要求 maxRetriesPerRequest: null）。 */
export function getRedisConnection(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return redisConnection;
}

export function getEvalQueue(): Queue<EvalJobData> {
  if (!evalQueue) {
    evalQueue = new Queue<EvalJobData>(EVAL_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return evalQueue;
}

export function getServiceAssuranceQueue(): Queue<ServiceAssuranceJobData> {
  if (!serviceAssuranceQueue) {
    serviceAssuranceQueue = new Queue<ServiceAssuranceJobData>(SERVICE_ASSURANCE_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return serviceAssuranceQueue;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: 100,
  removeOnFail: 200,
  attempts: 1,
};

/**
 * 评估任务入队。测试环境（LSE_TEST=1）下跳过，避免依赖外部 Redis；
 * 入队失败仅记录日志、不抛出，保证创建/重评接口不被队列故障拖垮。
 */
export async function enqueueEvalTask(taskId: string): Promise<void> {
  if (isTest) return;
  try {
    await getEvalQueue().add('run', { taskId }, DEFAULT_JOB_OPTIONS);
  } catch (err) {
    console.error(`[queue] 评估任务入队失败 taskId=${taskId}:`, (err as Error).message);
  }
}

export async function enqueueServiceAssuranceRun(runId: string): Promise<void> {
  if (isTest) return;
  await getServiceAssuranceQueue().add('run', { runId }, { ...DEFAULT_JOB_OPTIONS, jobId: runId });
}

export function evalTaskCancelKey(taskId: string): string {
  return `evaltask:cancel:${taskId}`;
}

export async function requestEvalTaskCancel(taskId: string): Promise<void> {
  await getRedisConnection().set(
    evalTaskCancelKey(taskId),
    '1',
    'EX',
    EVAL_TASK_CANCEL_TTL_SECONDS,
  );
}

/**
 * 清除取消标记。重新评估（re-eval）时必须调用：否则上一次取消写入的
 * `evaltask:cancel:<id>` 在 1h TTL 内仍存在，重评任务一进执行循环就被
 * isEvalTaskCancelRequested 判为已取消，0/10 秒退（stale-cancel bug）。
 */
export async function clearEvalTaskCancel(taskId: string): Promise<void> {
  if (isTest) return;
  await getRedisConnection().del(evalTaskCancelKey(taskId));
}

export async function isEvalTaskCancelRequested(taskId: string): Promise<boolean> {
  if (isTest) return false;
  const value = await getRedisConnection().get(evalTaskCancelKey(taskId));
  return value === '1';
}

/** 评估任务暂停（2.4.2）：执行器派下一题前看这个键，为真就不再派题，在途的题做完后置为已暂停。 */
export function evalTaskPauseKey(taskId: string): string {
  return `evaltask:pause:${taskId}`;
}

export async function requestEvalTaskPause(taskId: string): Promise<void> {
  await getRedisConnection().set(evalTaskPauseKey(taskId), '1', 'EX', EVAL_TASK_PAUSE_TTL_SECONDS);
}

/** 恢复、重评、停止和执行器停下来后清掉，否则下次执行一开始就会被当成要暂停。 */
export async function clearEvalTaskPause(taskId: string): Promise<void> {
  if (isTest) return;
  await getRedisConnection().del(evalTaskPauseKey(taskId));
}

export async function isEvalTaskPauseRequested(taskId: string): Promise<boolean> {
  if (isTest) return false;
  const value = await getRedisConnection().get(evalTaskPauseKey(taskId));
  return value === '1';
}

export function serviceAssuranceCancelKey(runId: string): string {
  return `serviceassurance:cancel:${runId}`;
}

export async function requestServiceAssuranceCancel(runId: string): Promise<void> {
  if (isTest) return;
  await getRedisConnection().set(
    serviceAssuranceCancelKey(runId),
    '1',
    'EX',
    SERVICE_ASSURANCE_CANCEL_TTL_SECONDS,
  );
}

export async function clearServiceAssuranceCancel(runId: string): Promise<void> {
  if (isTest) return;
  await getRedisConnection().del(serviceAssuranceCancelKey(runId));
}

export async function isServiceAssuranceCancelRequested(runId: string): Promise<boolean> {
  if (isTest) return false;
  return (await getRedisConnection().get(serviceAssuranceCancelKey(runId))) === '1';
}

export const MODEL_FILE_SCAN_QUEUE_NAME = 'model-file-scan';
export interface ModelFileScanJobData {
  scanId: string;
}
let modelFileScanQueue: Queue<ModelFileScanJobData> | null = null;

export function getModelFileScanQueue(): Queue<ModelFileScanJobData> {
  if (!modelFileScanQueue) {
    modelFileScanQueue = new Queue<ModelFileScanJobData>(MODEL_FILE_SCAN_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return modelFileScanQueue;
}

/** 模型文件扫描入队。测试环境跳过（测试直接调用执行器）；入队失败抛出，由调用方把记录置为失败。 */
export async function enqueueModelFileScan(scanId: string): Promise<void> {
  if (isTest) return;
  await getModelFileScanQueue().add('run', { scanId }, { ...DEFAULT_JOB_OPTIONS, jobId: scanId });
}

// ---------- 语料扫描（数据安全工具） ----------
export const CORPUS_SCAN_QUEUE_NAME = 'corpus-scan';
export interface CorpusScanJobData {
  scanId: string;
}
let corpusScanQueue: Queue<CorpusScanJobData> | null = null;

export function getCorpusScanQueue(): Queue<CorpusScanJobData> {
  if (!corpusScanQueue) {
    corpusScanQueue = new Queue<CorpusScanJobData>(CORPUS_SCAN_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return corpusScanQueue;
}

/** 语料扫描入队。测试环境跳过（测试直接调用执行器）；入队失败抛出，由路由把记录置为失败。 */
export async function enqueueCorpusScan(scanId: string): Promise<void> {
  if (isTest) return;
  await getCorpusScanQueue().add('run', { scanId }, { ...DEFAULT_JOB_OPTIONS, jobId: scanId });
}

/** 每天清理超过保留天数的语料原文件和打码副本（上海时区 04:00）。 */
export const CORPUS_RETENTION_JOB_NAME = 'retention';

/**
 * worker 侧的语料扫描消费者。执行器在处理时按需加载：@lse/api 的 package.json exports 不新增入口，
 * worker 只从 @lse/api/queue 引入这个工厂。
 */
export function createCorpusScanWorker(concurrency = 1): Worker<CorpusScanJobData> {
  return new Worker<CorpusScanJobData>(
    CORPUS_SCAN_QUEUE_NAME,
    async (job) => {
      const executor = await import('../modules/corpus-scans/executor.js');
      if (job.name === CORPUS_RETENTION_JOB_NAME) {
        await executor.purgeExpiredCorpusFiles();
        return;
      }
      await executor.runCorpusScan(job.data.scanId);
    },
    { connection: getRedisConnection(), concurrency: Math.max(1, concurrency) },
  );
}

/**
 * worker 启动时调用（只处理语料扫描这一个队列）：把 bootAt 之前开始、还停在 RUNNING 的扫描置为失败
 * （进程重启后不会再有人接着跑），并注册每天的文件清理。返回置为失败的条数。
 */
export async function startCorpusScanMaintenance(bootAt: Date): Promise<number> {
  const { failInterruptedCorpusScans } = await import('../modules/corpus-scans/executor.js');
  const failed = await failInterruptedCorpusScans(bootAt);
  await getCorpusScanQueue().upsertJobScheduler(
    'corpus-retention-daily',
    { pattern: '0 4 * * *', tz: 'Asia/Shanghai' },
    {
      name: CORPUS_RETENTION_JOB_NAME,
      data: { scanId: '' },
      opts: { removeOnComplete: 10, removeOnFail: 20, attempts: 1 },
    },
  );
  return failed;
}

// ---------- 检测任务：组合任务编排、检测策略调度（2.4.3、2.4.9） ----------
export const DETECT_JOBS_QUEUE_NAME = 'detect-jobs';
export const DETECT_STRATEGIES_QUEUE_NAME = 'detect-strategies';
/** 组合任务推进的定时任务名（每 15 秒一次） */
export const DETECT_JOB_TICK_NAME = 'tick';
export const DETECT_JOB_TICK_EVERY_MS = 15_000;

let detectJobsQueue: Queue | null = null;
let detectStrategiesQueue: Queue<{ strategyId: string }> | null = null;

export function getDetectJobsQueue(): Queue {
  if (!detectJobsQueue) {
    detectJobsQueue = new Queue(DETECT_JOBS_QUEUE_NAME, { connection: getRedisConnection() });
  }
  return detectJobsQueue;
}

export function getDetectStrategiesQueue(): Queue<{ strategyId: string }> {
  if (!detectStrategiesQueue) {
    detectStrategiesQueue = new Queue<{ strategyId: string }>(DETECT_STRATEGIES_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return detectStrategiesQueue;
}

/**
 * worker 侧的检测任务消费者：组合任务推进（tick）和检测策略触发。处理时按需加载模块，
 * worker 只从 @lse/api/queue 引入（不新增 package.json 的 exports 入口）。
 */
export function createDetectWorkers(): Worker[] {
  const jobs = new Worker(
    DETECT_JOBS_QUEUE_NAME,
    async (job) => {
      if (job.name !== DETECT_JOB_TICK_NAME) return;
      const { tickDetectJobs } = await import('../modules/detect-jobs/orchestrator.js');
      await tickDetectJobs();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );
  const strategies = new Worker<{ strategyId: string }>(
    DETECT_STRATEGIES_QUEUE_NAME,
    async (job) => {
      const [{ prismaUnscoped }, { runInTenant }, { PLATFORM_TENANT_ID }, strategies] =
        await Promise.all([
          import('../db.js'),
          import('./tenant-context.js'),
          import('./tenant-models.js'),
          import('../modules/detect-jobs/strategies.js'),
        ]);
      const strategy = await prismaUnscoped.detectStrategy.findUnique({
        where: { id: job.data.strategyId },
        select: { id: true, tenantId: true },
      });
      if (!strategy) return { status: 'skipped', reason: '检测策略不存在' };
      // 调度没有租户上下文：按策略所属租户执行，建出的组合任务和检测记录都归这个租户。
      return runInTenant(strategy.tenantId ?? PLATFORM_TENANT_ID, () =>
        strategies.triggerDetectStrategy(strategy.id, { triggeredBy: 'schedule' }),
      );
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );
  return [jobs, strategies];
}

/** worker 启动时调用：注册组合任务推进的定时任务（每 15 秒），并按库对齐检测策略的调度。 */
export async function startDetectMaintenance(): Promise<void> {
  const [{ reconcileDetectStrategySchedulers }, { recoverInterruptedDetectWork }] =
    await Promise.all([
      import('../modules/detect-jobs/strategy-scheduler.js'),
      import('../modules/detect-jobs/orchestrator.js'),
    ]);
  // 上次进程在启动途中中断的子任务、worker 里执行被重启打断的资产测绘：置失败收尾。
  await recoverInterruptedDetectWork();
  await reconcileDetectStrategySchedulers(getDetectStrategiesQueue());
  await getDetectJobsQueue().upsertJobScheduler(
    'detect-jobs-tick',
    { every: DETECT_JOB_TICK_EVERY_MS },
    {
      name: DETECT_JOB_TICK_NAME,
      data: {},
      opts: { removeOnComplete: 10, removeOnFail: 20, attempts: 1 },
    },
  );
}

/** 优雅关闭（worker / API 退出时调用）。 */
export async function closeQueue(): Promise<void> {
  if (detectJobsQueue) {
    await detectJobsQueue.close();
    detectJobsQueue = null;
  }
  if (detectStrategiesQueue) {
    await detectStrategiesQueue.close();
    detectStrategiesQueue = null;
  }
  if (corpusScanQueue) {
    await corpusScanQueue.close();
    corpusScanQueue = null;
  }
  if (batchEvaluationQueue) {
    await batchEvaluationQueue.close();
    batchEvaluationQueue = null;
  }
  if (modelFileScanQueue) {
    await modelFileScanQueue.close();
    modelFileScanQueue = null;
  }
  if (ragTestGenQueue) {
    await ragTestGenQueue.close();
    ragTestGenQueue = null;
  }
  if (serviceAssuranceQueue) {
    await serviceAssuranceQueue.close();
    serviceAssuranceQueue = null;
  }
  if (evalQueue) {
    await evalQueue.close();
    evalQueue = null;
  }
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}

// ---------- RAG 专项评估：测试集生成队列 ----------
export const RAG_TESTGEN_QUEUE_NAME = 'rag-testgen';

export interface RagTestGenJobData {
  testSetId: string;
}

let ragTestGenQueue: Queue<RagTestGenJobData> | null = null;

export function getRagTestGenQueue(): Queue<RagTestGenJobData> {
  if (!ragTestGenQueue) {
    ragTestGenQueue = new Queue<RagTestGenJobData>(RAG_TESTGEN_QUEUE_NAME, {
      connection: getRedisConnection(),
    });
  }
  return ragTestGenQueue;
}

/** RAG 测试集生成入队（测试环境跳过；入队失败抛出，由路由把测试集标记为失败）。 */
export async function enqueueRagTestGen(testSetId: string): Promise<void> {
  if (isTest) return;
  await getRagTestGenQueue().add(
    'generate',
    { testSetId },
    { ...DEFAULT_JOB_OPTIONS, jobId: testSetId },
  );
}
