-- 鉴盾对标二期第二批 B 线：组合检测任务（2.4.9）与检测策略（2.4.3）。
-- 三张表都按租户隔离（登记在 tenant-models.ts 的 TENANT_OWNED_MODELS），没带租户写入时按创建人或组合任务补齐。
-- detect_jobs."schemeId"、detect_job_items."ledgerAssetId" 的外键和守卫由 C 线迁移 20261122120200 补。

CREATE TABLE "detect_strategies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL,
    "maxParallel" INTEGER NOT NULL DEFAULT 4,
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastTriggeredAt" TIMESTAMP(3),
    "lastSkipReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detect_strategies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detect_jobs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "maxParallel" INTEGER NOT NULL DEFAULT 4,
    "strategyId" TEXT,
    "schemeId" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detect_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detect_job_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "jobId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "toolId" TEXT,
    "ledgerAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "recordKind" TEXT,
    "recordId" TEXT,
    "error" TEXT,
    "launchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detect_job_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "detect_strategies_tenantId_idx" ON "detect_strategies"("tenantId");

CREATE UNIQUE INDEX "detect_strategies_tenantId_name_key" ON "detect_strategies"("tenantId", "name");

CREATE INDEX "detect_jobs_tenantId_idx" ON "detect_jobs"("tenantId");

CREATE INDEX "detect_jobs_status_idx" ON "detect_jobs"("status");

CREATE INDEX "detect_jobs_strategyId_createdAt_idx" ON "detect_jobs"("strategyId", "createdAt");

CREATE INDEX "detect_jobs_schemeId_idx" ON "detect_jobs"("schemeId");

CREATE INDEX "detect_job_items_recordKind_recordId_idx" ON "detect_job_items"("recordKind", "recordId");

CREATE INDEX "detect_job_items_ledgerAssetId_idx" ON "detect_job_items"("ledgerAssetId");

CREATE INDEX "detect_job_items_tenantId_idx" ON "detect_job_items"("tenantId");

CREATE UNIQUE INDEX "detect_job_items_jobId_position_key" ON "detect_job_items"("jobId", "position");

ALTER TABLE "detect_jobs" ADD CONSTRAINT "detect_jobs_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "detect_strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "detect_job_items" ADD CONSTRAINT "detect_job_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "detect_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 没带租户写入时：策略、组合任务跟随创建人，子任务跟随组合任务（worker 推进时没有租户上下文）；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "detect_strategies" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "detect_jobs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "detect_job_items" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('detect_jobs:jobId', '@default');
-- 组合任务引用的策略必须是同一租户的。
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "strategyId" ON "detect_jobs" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('detect_strategies:strategyId');

-- 权限：查看检测任务给四个内置角色；管理组合任务和检测策略给 admin、tenant_admin、operator。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('detect_task:read'), 'detect_task:read', '查看检测任务', '检测任务'),
  (md5('detect_task:manage'), 'detect_task:manage', '管理组合任务和检测策略', '检测任务')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('detect_task:read', 'detect_task:manage')
WHERE role."name" IN ('admin', 'tenant_admin', 'operator')
   OR (role."name" = 'auditor' AND permission."code" = 'detect_task:read')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
