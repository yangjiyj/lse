import { prisma } from '../../db.js';
import { AgentShieldClient } from './agentshield-client.js';
import { callbackSchema, endpointEvalEnabled } from './config.js';
import { applyEndpointUpdate, ENDPOINT_ENGINE, JOB_LOG, parseBinding } from './service.js';

export async function pollEndpointJobs(
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  if (!endpointEvalEnabled()) return;
  const tasks = await prisma.evalTask.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] },
      engines: { has: ENDPOINT_ENGINE },
      modelTarget: { targetType: 'ENDPOINT_AGENT' },
    },
    select: { id: true, logs: { where: { message: JOB_LOG }, take: 1 } },
  });
  const client = new AgentShieldClient();
  for (const task of tasks) {
    const binding = task.logs[0] ? parseBinding(task.logs[0].context) : null;
    if (!binding?.jobId) continue;
    try {
      const job = await client.job(binding.jobId);
      if (job.job_id && job.job_id !== binding.jobId)
        throw new Error('连接器查询返回错误的任务标识');
      await applyEndpointUpdate(
        callbackSchema.parse({ ...job, job_id: binding.jobId, lse_task_id: task.id }),
      );
    } catch (error) {
      onError(error);
    }
  }
}
