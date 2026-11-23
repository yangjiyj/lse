import { Worker, type Job } from 'bullmq';
import {
  EVAL_QUEUE_NAME,
  BATCH_EVALUATION_QUEUE_NAME,
  getBatchEvaluationQueue,
  SERVICE_ASSURANCE_QUEUE_NAME,
  MODEL_FILE_SCAN_QUEUE_NAME,
  RAG_TESTGEN_QUEUE_NAME,
  getRedisConnection,
  closeQueue,
  createCorpusScanWorker,
  startCorpusScanMaintenance,
  createDetectWorkers,
  startDetectMaintenance,
  type EvalJobData,
  type ServiceAssuranceJobData,
  type ModelFileScanJobData,
  type RagTestGenJobData,
} from '@lse/api/queue';
import { runModelFileScan } from '@lse/api/model-file-scan-executor';
import { runEvalTask } from '@lse/api/eval-executor';
import { prisma } from '@lse/api/db';
import { runStandardEvaluationByTaskId } from '@lse/api/standard-evaluation-executor';
import { runRagEvaluation } from '@lse/api/rag-eval-executor';
import { runRagTestSetGeneration } from '@lse/api/rag-testgen-job';
import { executeServiceAssuranceRun } from '@lse/api/service-assurance-orchestrator';
import { createWorkerDefinitions } from './workers.js';
import { runBatchEvaluation } from '@lse/api/batch-evaluation-executor';
import { recoverBatchEvaluations } from '@lse/api/batch-evaluation-recovery';

const batchEvaluationWorker = new Worker<{ planId: string }>(
  BATCH_EVALUATION_QUEUE_NAME,
  async (job) => {
    if (job.name === 'recover') {
      await recoverBatchEvaluations();
      return;
    }
    await runBatchEvaluation(job.data.planId);
  },
  { connection: getRedisConnection(), concurrency: 2 },
);
batchEvaluationWorker.on('error', () => console.error('[worker] 批量评估队列连接异常'));
batchEvaluationWorker.on('failed', (job) =>
  console.error(`[worker] 批量评估执行失败 plan=${job?.data.planId ?? 'recovery'}`),
);
void getBatchEvaluationQueue()
  .upsertJobScheduler(
    'batch-evaluation-recovery',
    { every: 60000 },
    { name: 'recover', data: { planId: '' }, opts: { removeOnComplete: 10, removeOnFail: 20 } },
  )
  .catch(() => console.error('[worker] 批量评估恢复调度注册失败'));
import {
  closeBankUpdateQueue,
  createBankUpdateWorker,
  syncBankUpdateSchedulers,
} from '@lse/api/gbt-bank-updates';
import {
  closeEvalPlanQueue,
  createEvalPlanWorker,
  getEvalPlanQueue,
  reconcilePlanSchedulers,
} from '@lse/api/eval-plan-scheduler';

const [evaluationDefinition, serviceAssuranceDefinition] = createWorkerDefinitions({
  evalQueueName: EVAL_QUEUE_NAME,
  serviceAssuranceQueueName: SERVICE_ASSURANCE_QUEUE_NAME,
  evalConcurrency: process.env.WORKER_CONCURRENCY,
  serviceAssuranceConcurrency: process.env.SERVICE_ASSURANCE_WORKER_CONCURRENCY,
  runEvalTask: async (taskId) => {
    const standardRun = await prisma.standardRun.findUnique({
      where: { taskId },
      select: { id: true },
    });
    if (standardRun) {
      console.log(`[worker] 分发标准专项执行器 taskId=${taskId} runId=${standardRun.id}`);
      await runStandardEvaluationByTaskId(taskId);
      return;
    }
    const ragEvalRun = await prisma.ragEvalRun.findUnique({
      where: { taskId },
      select: { id: true },
    });
    if (ragEvalRun) {
      console.log(`[worker] 分发 RAG 专项评估执行器 taskId=${taskId} runId=${ragEvalRun.id}`);
      await runRagEvaluation(taskId);
      return;
    }
    await runEvalTask(taskId);
  },
  executeServiceAssuranceRun,
});

const evaluationWorker = new Worker<EvalJobData>(
  evaluationDefinition.queueName,
  async (job: Job<EvalJobData>) => {
    console.log(`[worker] 开始处理评估任务 job=${job.id} taskId=${job.data.taskId}`);
    await evaluationDefinition.process(job);
  },
  { connection: getRedisConnection(), concurrency: evaluationDefinition.concurrency },
);

const serviceAssuranceWorker = new Worker<ServiceAssuranceJobData>(
  serviceAssuranceDefinition.queueName,
  async (job: Job<ServiceAssuranceJobData>) => {
    console.log(`[worker] 开始处理服务安全核验 job=${job.id} runId=${job.data.runId}`);
    await serviceAssuranceDefinition.process(job);
  },
  { connection: getRedisConnection(), concurrency: serviceAssuranceDefinition.concurrency },
);

// RAG 测试集生成：逐题调用评估模型，耗时长，走独立队列，避免 HTTP 同步生成超时。
const ragTestGenWorker = new Worker<RagTestGenJobData>(
  RAG_TESTGEN_QUEUE_NAME,
  async (job: Job<RagTestGenJobData>) => {
    console.log(`[worker] 开始生成 RAG 测试集 job=${job.id} testSetId=${job.data.testSetId}`);
    await runRagTestSetGeneration(job.data.testSetId);
  },
  { connection: getRedisConnection(), concurrency: 1 },
);
ragTestGenWorker.on('failed', (job, err) => {
  console.error(`[worker] RAG 测试集生成失败 testSetId=${job?.data.testSetId}:`, err?.message);
});
ragTestGenWorker.on('error', (err) => {
  console.error('[worker] RAG 测试集生成 worker 错误:', err.message);
});

evaluationWorker.on('completed', (job) => {
  console.log(`[worker] 任务完成 job=${job.id} taskId=${job.data.taskId}`);
});
evaluationWorker.on('failed', (job, err) => {
  console.error(`[worker] 任务失败 job=${job?.id} taskId=${job?.data.taskId}:`, err?.message);
});
evaluationWorker.on('error', (err) => {
  console.error('[worker] worker 错误:', err.message);
});

serviceAssuranceWorker.on('completed', (job) => {
  console.log(`[worker] 服务安全核验完成 job=${job.id} runId=${job.data.runId}`);
});
serviceAssuranceWorker.on('failed', (job, err) => {
  console.error(`[worker] 服务安全核验失败 job=${job?.id} runId=${job?.data.runId}:`, err?.message);
});
serviceAssuranceWorker.on('error', (err) => {
  console.error('[worker] 服务安全核验 worker 错误:', err.message);
});

// 模型文件扫描：纯本地 IO，默认并发 1，避免多个大模型同时读盘。
const modelFileScanWorker = new Worker<ModelFileScanJobData>(
  MODEL_FILE_SCAN_QUEUE_NAME,
  async (job: Job<ModelFileScanJobData>) => {
    console.log(`[worker] 开始模型文件扫描 job=${job.id} scanId=${job.data.scanId}`);
    await runModelFileScan(job.data.scanId);
  },
  {
    connection: getRedisConnection(),
    concurrency: Math.max(1, Number(process.env.MODEL_FILE_SCAN_WORKER_CONCURRENCY) || 1),
  },
);
modelFileScanWorker.on('failed', (job, err) => {
  console.error(`[worker] 模型文件扫描失败 scanId=${job?.data.scanId}:`, err?.message);
});
modelFileScanWorker.on('error', (err) => {
  console.error('[worker] 模型文件扫描 worker 错误:', err.message);
});

// 语料扫描：流式读语料文件逐条检测，默认并发 1，避免多个大文件同时读盘。
// 启动时把上次进程留下的 RUNNING 扫描置为失败（只按启动前的开始时间判断），并注册每天的文件清理。
const corpusScanBootAt = new Date();
const corpusScanWorker = createCorpusScanWorker(
  Number(process.env.CORPUS_SCAN_WORKER_CONCURRENCY) || 1,
);
startCorpusScanMaintenance(corpusScanBootAt)
  .then((n) => console.log(`[worker] 语料扫描维护已启动，中断的扫描置为失败 ${n} 条`))
  .catch((err) => console.error('[worker] 语料扫描维护启动失败:', (err as Error).message));
corpusScanWorker.on('failed', (job, err) => {
  console.error(`[worker] 语料扫描失败 scanId=${job?.data.scanId}:`, err?.message);
});
corpusScanWorker.on('error', (err) => {
  console.error('[worker] 语料扫描 worker 错误:', err.message);
});

// 检测任务：组合任务每 15 秒推进一次（按并发上限启动子任务、同步状态、收尾），检测策略按周期触发。
const detectWorkers = createDetectWorkers();
for (const w of detectWorkers) {
  w.on('failed', (job, err) => {
    console.error(`[worker] 检测任务队列处理失败 queue=${w.name} job=${job?.id}:`, err?.message);
  });
  w.on('error', (err) => {
    console.error(`[worker] 检测任务 worker 错误 queue=${w.name}:`, err.message);
  });
}
startDetectMaintenance()
  .then(() => console.log('[worker] 组合任务推进调度已注册'))
  .catch((err) => console.error('[worker] 组合任务推进调度注册失败:', (err as Error).message));

// 评估计划调度：BullMQ Job Scheduler 产生触发 job，消费者调用 triggerEvalPlan。
const evalPlanWorker = createEvalPlanWorker(prisma);
evalPlanWorker.on('completed', (job, result) => {
  console.log(`[worker] 评估计划触发 planId=${job.data.planId} 结果=${JSON.stringify(result)}`);
});
evalPlanWorker.on('failed', (job, err) => {
  console.error(`[worker] 评估计划触发失败 planId=${job?.data.planId}:`, err?.message);
});
evalPlanWorker.on('error', (err) => {
  console.error('[worker] 评估计划 worker 错误:', err.message);
});
// 启动时按库对齐 scheduler（API 侧同步失败或 Redis 数据丢失后自愈）。
reconcilePlanSchedulers(prisma, getEvalPlanQueue())
  .then((r) => console.log(`[worker] 评估计划调度已对齐 注册=${r.upserted} 移除=${r.removed}`))
  .catch((err) => console.error('[worker] 评估计划调度对齐失败:', (err as Error).message));

// GB/T 45654 题库与关键词库定期更新（附录 B.1 c)、B.2 d)、B.3 c)）：题库每月 1 日、关键词每周一，上海时区 03:00。
// 默认关闭（题库随产品版本发布）；BANK_AUTO_UPDATE_ENABLED=true 才注册定时，关闭时移除以前注册的定时。
const bankUpdateWorker = createBankUpdateWorker(prisma);
bankUpdateWorker.on('completed', (job, result) => {
  console.log(`[worker] 题库定期更新完成 kind=${job.data.kind} 结果=${JSON.stringify(result)}`);
});
bankUpdateWorker.on('failed', (job, err) => {
  console.error(`[worker] 题库定期更新失败 kind=${job?.data.kind}:`, err?.message);
});
bankUpdateWorker.on('error', (err) => {
  console.error('[worker] 题库定期更新 worker 错误:', err.message);
});
syncBankUpdateSchedulers()
  .then((r) => console.log(r === 'registered' ? '[worker] 题库定期更新调度已注册' : '[worker] 题库定期更新未开启，已移除定时'))
  .catch((err) => console.error('[worker] 题库定期更新调度同步失败:', (err as Error).message));

console.log(
  `[worker] worker 已启动，评估队列=${evaluationDefinition.queueName} 并发=${evaluationDefinition.concurrency}，服务核验队列=${serviceAssuranceDefinition.queueName} 并发=${serviceAssuranceDefinition.concurrency}`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] 收到 ${signal}，正在优雅关闭…`);
  try {
    await Promise.all([
      evaluationWorker.close(),
      batchEvaluationWorker.close(),
      serviceAssuranceWorker.close(),
      modelFileScanWorker.close(),
      corpusScanWorker.close(),
      ragTestGenWorker.close(),
      evalPlanWorker.close(),
      bankUpdateWorker.close(),
      ...detectWorkers.map((w) => w.close()),
    ]);
    await closeEvalPlanQueue();
    await closeBankUpdateQueue();
    await closeQueue();
  } catch (err) {
    console.error('[worker] 关闭时出错:', (err as Error).message);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
