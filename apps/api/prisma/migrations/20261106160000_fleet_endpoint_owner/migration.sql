-- 终端资产台账：给终端记责任人（姓名、部门、可选关联平台用户）。
ALTER TABLE "fleet_endpoints" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "fleet_endpoints" ADD COLUMN "ownerDepartment" TEXT;
ALTER TABLE "fleet_endpoints" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "fleet_endpoints" ADD COLUMN "ownerUpdatedAt" TIMESTAMP(3);
