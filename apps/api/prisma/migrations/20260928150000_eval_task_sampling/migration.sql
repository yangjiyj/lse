-- 抽样评测：大题库按分类分层抽样，种子可复现。
ALTER TABLE "eval_tasks" ADD COLUMN "sampleSize" INTEGER,
ADD COLUMN "sampleSeed" TEXT;
