-- 鉴盾对标二期第二批 B 线：评估任务暂停、恢复（2.4.2）。
-- pausedAt：执行器停下来的时间，不为空表示下次执行是接续；pauseState：{ engineAccum, redTeamLaps }。

ALTER TABLE "eval_tasks" ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "pauseState" JSONB;
