-- AlterTable
ALTER TABLE "eval_tasks" ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "eval_plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetId" TEXT NOT NULL,
    "templateParams" JSONB NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastTriggeredAt" TIMESTAMP(3),
    "lastSkipReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_plan_runs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "taskId" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_plan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eval_plans_targetId_idx" ON "eval_plans"("targetId");

-- CreateIndex
CREATE INDEX "eval_plan_runs_planId_createdAt_idx" ON "eval_plan_runs"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "eval_plan_runs_taskId_idx" ON "eval_plan_runs"("taskId");

-- CreateIndex
CREATE INDEX "eval_tasks_planId_createdAt_idx" ON "eval_tasks"("planId", "createdAt");

-- AddForeignKey
ALTER TABLE "eval_tasks" ADD CONSTRAINT "eval_tasks_planId_fkey" FOREIGN KEY ("planId") REFERENCES "eval_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_plans" ADD CONSTRAINT "eval_plans_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "model_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_plans" ADD CONSTRAINT "eval_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_plan_runs" ADD CONSTRAINT "eval_plan_runs_planId_fkey" FOREIGN KEY ("planId") REFERENCES "eval_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_plan_runs" ADD CONSTRAINT "eval_plan_runs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
