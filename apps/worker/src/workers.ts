export interface WorkerJob<Data> {
  id?: string | number;
  data: Data;
}

export interface WorkerDefinition<Data> {
  queueName: string;
  concurrency: number;
  process: (job: WorkerJob<Data>) => Promise<void>;
}

export interface WorkerDefinitionOptions {
  evalQueueName: string;
  serviceAssuranceQueueName: string;
  evalConcurrency?: string;
  serviceAssuranceConcurrency?: string;
  runEvalTask: (taskId: string) => Promise<void>;
  executeServiceAssuranceRun: (runId: string) => Promise<void>;
}

function concurrency(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, parsed));
}

export function createWorkerDefinitions(
  options: WorkerDefinitionOptions,
): [WorkerDefinition<{ taskId: string }>, WorkerDefinition<{ runId: string }>] {
  return [
    {
      queueName: options.evalQueueName,
      concurrency: concurrency(options.evalConcurrency, 2, 32),
      process: async (job) => options.runEvalTask(job.data.taskId),
    },
    {
      queueName: options.serviceAssuranceQueueName,
      concurrency: concurrency(options.serviceAssuranceConcurrency, 1, 4),
      process: async (job) => options.executeServiceAssuranceRun(job.data.runId),
    },
  ];
}
