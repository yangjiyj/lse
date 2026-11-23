-- AI 服务安全核验与评估任务解耦：taskId 放宽为可空，新增关联时间与发起人索引。仅放宽/新增，不删列。
ALTER TABLE "service_assurance_runs" ALTER COLUMN "taskId" DROP NOT NULL;
ALTER TABLE "service_assurance_runs" ADD COLUMN "linkedAt" TIMESTAMP(3);
CREATE INDEX "service_assurance_runs_createdById_createdAt_idx" ON "service_assurance_runs"("createdById", "createdAt");
