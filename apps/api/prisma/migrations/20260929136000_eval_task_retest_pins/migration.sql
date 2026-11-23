-- AlterTable
ALTER TABLE "eval_tasks" ADD COLUMN     "parentTaskId" TEXT,
ADD COLUMN     "retestMode" TEXT;

-- CreateTable
CREATE TABLE "eval_task_questions" (
    "taskId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_task_questions_pkey" PRIMARY KEY ("taskId","questionId")
);

-- CreateIndex
CREATE INDEX "eval_task_questions_questionId_idx" ON "eval_task_questions"("questionId");

-- CreateIndex
CREATE INDEX "eval_tasks_parentTaskId_idx" ON "eval_tasks"("parentTaskId");

-- AddForeignKey
ALTER TABLE "eval_tasks" ADD CONSTRAINT "eval_tasks_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "eval_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_task_questions" ADD CONSTRAINT "eval_task_questions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_task_questions" ADD CONSTRAINT "eval_task_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

