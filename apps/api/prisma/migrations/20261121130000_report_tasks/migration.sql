-- 2.6.3 多任务组合报告：组合报告不挂单个任务，reports.taskId 改为可空；包含的任务记在 report_tasks。
ALTER TABLE "reports" ALTER COLUMN "taskId" DROP NOT NULL;
-- 只有组合报告可以不挂任务；旧版本代码不认 taskId 为空的报告，回退前先删掉组合报告。
ALTER TABLE "reports" ADD CONSTRAINT "reports_combined_task_check" CHECK (("kind" = 'combined') = ("taskId" IS NULL));

-- taskId 不建外键：任务删除后保留这条记录，报告里那一节标「任务已删除」。
CREATE TABLE "report_tasks" (
    "reportId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "report_tasks_pkey" PRIMARY KEY ("reportId","taskId")
);

CREATE INDEX "report_tasks_taskId_idx" ON "report_tasks"("taskId");

ALTER TABLE "report_tasks" ADD CONSTRAINT "report_tasks_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 关联表没有租户列：报告与任务的租户不一致时拒绝写入（同 eval_task_question_sets）。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "reportId", "taskId" ON "report_tasks" FOR EACH ROW EXECUTE FUNCTION lse_tenant_link_guard('reports:reportId', 'eval_tasks:taskId');
