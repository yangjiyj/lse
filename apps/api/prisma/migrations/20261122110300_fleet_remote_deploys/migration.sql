-- 鉴盾对标二期第二批 B 线：远程部署终端探针（2.4.8）。凭据只在部署进程内存里用，不落库。

CREATE TABLE "fleet_remote_deploys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "mode" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL DEFAULT '',
    "authType" TEXT NOT NULL DEFAULT 'none',
    "hostKeyFingerprint" TEXT NOT NULL DEFAULT '',
    "hostKeyType" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "enrollmentCodeId" TEXT,
    "endpointId" TEXT,
    "postureTaskId" TEXT,
    "enableEval" BOOLEAN NOT NULL DEFAULT false,
    "runPosture" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "scriptFetchedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "firstReportAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_remote_deploys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fleet_remote_deploys_tenantId_idx" ON "fleet_remote_deploys"("tenantId");

CREATE INDEX "fleet_remote_deploys_enrollmentCodeId_idx" ON "fleet_remote_deploys"("enrollmentCodeId");

CREATE INDEX "fleet_remote_deploys_endpointId_idx" ON "fleet_remote_deploys"("endpointId");

CREATE INDEX "fleet_remote_deploys_status_updatedAt_idx" ON "fleet_remote_deploys"("status", "updatedAt");


-- 没带租户写入时跟随创建人；推不出来归平台租户。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "fleet_remote_deploys" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('users:createdById', '@default');

-- 权限：远程部署终端探针给 admin、tenant_admin。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('fleet:remote_deploy'), 'fleet:remote_deploy', '远程部署终端探针', '终端与智能体')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'fleet:remote_deploy'
WHERE role."name" IN ('admin', 'tenant_admin')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
