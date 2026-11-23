-- 2.7.3 自建样本库禁用：禁用后不能再用来建任务，已有任务不受影响
ALTER TABLE "question_sets" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
