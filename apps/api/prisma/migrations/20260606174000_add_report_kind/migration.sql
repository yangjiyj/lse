-- AlterTable
ALTER TABLE "reports" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'safety_overview';

-- CreateIndex
CREATE INDEX "reports_taskId_kind_idx" ON "reports"("taskId", "kind");
