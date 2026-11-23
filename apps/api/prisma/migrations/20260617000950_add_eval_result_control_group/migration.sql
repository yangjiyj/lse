-- AlterTable
ALTER TABLE "eval_results" ADD COLUMN     "controlGroupId" TEXT,
ADD COLUMN     "side" TEXT;

-- CreateIndex
CREATE INDEX "eval_results_taskId_controlGroupId_idx" ON "eval_results"("taskId", "controlGroupId");

