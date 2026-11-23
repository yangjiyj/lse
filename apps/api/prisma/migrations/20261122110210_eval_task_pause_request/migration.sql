-- 鉴盾对标二期第二批 B 线：评估任务「暂停中」（已请求暂停、执行器还没停下）落库，页面和撤销暂停要用。

ALTER TABLE "eval_tasks" ADD COLUMN "pauseRequestedAt" TIMESTAMP(3);
