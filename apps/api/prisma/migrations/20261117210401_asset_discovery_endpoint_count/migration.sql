-- AI 资产测绘：扫描记录保存实际探测的端点数（URL、「主机:端口」目标与网段目标混填时，不等于主机数 × 端口数）
ALTER TABLE "asset_discovery_runs" ADD COLUMN "endpointCount" INTEGER NOT NULL DEFAULT 0;

-- 已有记录只有网段、主机目标，端点数就是主机数 × 端口数
UPDATE "asset_discovery_runs" SET "endpointCount" = "hostCount" * "portCount";
