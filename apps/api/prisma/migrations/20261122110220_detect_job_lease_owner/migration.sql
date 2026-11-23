-- 鉴盾对标二期第二批 B 线：组合任务租约记持有者，续租和释放只动自己持有的租约。

ALTER TABLE "detect_jobs" ADD COLUMN "leaseOwner" TEXT;
