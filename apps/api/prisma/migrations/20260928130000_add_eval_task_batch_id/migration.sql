-- AlterTable
ALTER TABLE "eval_tasks" ADD COLUMN "batchId" TEXT;

-- CreateIndex
CREATE INDEX "eval_tasks_batchId_idx" ON "eval_tasks"("batchId");
