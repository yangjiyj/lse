-- AI 资产测绘（影子 AI）：扫描运行与命中结果。范围配置存于 system_settings。
-- CreateTable
CREATE TABLE "asset_discovery_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "targets" TEXT[],
    "ports" INTEGER[],
    "hostCount" INTEGER NOT NULL,
    "portCount" INTEGER NOT NULL,
    "probedCount" INTEGER NOT NULL DEFAULT 0,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_discovery_hits" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "models" TEXT[],
    "evidence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_discovery_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_discovery_runs_createdAt_idx" ON "asset_discovery_runs"("createdAt");

-- CreateIndex
CREATE INDEX "asset_discovery_hits_runId_idx" ON "asset_discovery_hits"("runId");

-- AddForeignKey
ALTER TABLE "asset_discovery_hits" ADD CONSTRAINT "asset_discovery_hits_runId_fkey" FOREIGN KEY ("runId") REFERENCES "asset_discovery_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

