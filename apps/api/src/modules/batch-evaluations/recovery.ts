import { prisma } from '../../db.js';
import { enqueueBatchEvaluation } from '../../lib/queue.js';

export async function recoverBatchEvaluations(enqueue = enqueueBatchEvaluation): Promise<number> {
  const now = new Date();
  const plans = await prisma.batchEvaluation.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] },
      startedAt: { not: null },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    select: { id: true },
    take: 100,
    orderBy: { updatedAt: 'asc' },
  });
  for (const plan of plans) await enqueue(plan.id);
  return plans.length;
}
