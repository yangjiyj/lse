-- CreateEnum
CREATE TYPE "FleetEnrollmentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FleetEndpointStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "FleetJobStatus" AS ENUM ('PENDING_APPROVAL', 'QUEUED', 'DELIVERED', 'RUNNING', 'COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "fleet_enrollment_codes" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "FleetEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "fleet_enrollment_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_endpoints" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL DEFAULT '',
    "arch" TEXT NOT NULL DEFAULT '',
    "osUser" TEXT NOT NULL DEFAULT '',
    "agentVersion" TEXT NOT NULL DEFAULT '',
    "capabilities" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "status" "FleetEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastHealth" JSONB,
    "evalRunner" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "enrollmentCodeId" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "fleet_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_probe_reports" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "assetCount" INTEGER NOT NULL DEFAULT 0,
    "bodyHash" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fleet_probe_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fleet_eval_jobs" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "evalTaskId" TEXT,
    "product" TEXT NOT NULL,
    "payloadCanonical" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "scenarioCount" INTEGER NOT NULL,
    "status" "FleetJobStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedById" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_eval_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_enrollment_codes_codeHash_key" ON "fleet_enrollment_codes"("codeHash");

-- CreateIndex
CREATE INDEX "fleet_enrollment_codes_status_expiresAt_idx" ON "fleet_enrollment_codes"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_endpoints_publicId_key" ON "fleet_endpoints"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_endpoints_installationId_key" ON "fleet_endpoints"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_endpoints_tokenHash_key" ON "fleet_endpoints"("tokenHash");

-- CreateIndex
CREATE INDEX "fleet_endpoints_machineId_idx" ON "fleet_endpoints"("machineId");

-- CreateIndex
CREATE INDEX "fleet_endpoints_lastSeenAt_idx" ON "fleet_endpoints"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_probe_reports_reportId_key" ON "fleet_probe_reports"("reportId");

-- CreateIndex
CREATE INDEX "fleet_probe_reports_endpointId_scannedAt_idx" ON "fleet_probe_reports"("endpointId", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "fleet_eval_jobs_publicId_key" ON "fleet_eval_jobs"("publicId");

-- CreateIndex
CREATE INDEX "fleet_eval_jobs_endpointId_status_idx" ON "fleet_eval_jobs"("endpointId", "status");

-- CreateIndex
CREATE INDEX "fleet_eval_jobs_status_createdAt_idx" ON "fleet_eval_jobs"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "fleet_enrollment_codes" ADD CONSTRAINT "fleet_enrollment_codes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_endpoints" ADD CONSTRAINT "fleet_endpoints_enrollmentCodeId_fkey" FOREIGN KEY ("enrollmentCodeId") REFERENCES "fleet_enrollment_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_probe_reports" ADD CONSTRAINT "fleet_probe_reports_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "fleet_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_eval_jobs" ADD CONSTRAINT "fleet_eval_jobs_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "fleet_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_eval_jobs" ADD CONSTRAINT "fleet_eval_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_eval_jobs" ADD CONSTRAINT "fleet_eval_jobs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "external_asset_assessments_sourceTenantId_sourceAssetId_created" RENAME TO "external_asset_assessments_sourceTenantId_sourceAssetId_cre_idx";
