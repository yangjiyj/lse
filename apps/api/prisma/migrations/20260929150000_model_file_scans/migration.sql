-- CreateEnum
CREATE TYPE "ModelFileScanSource" AS ENUM ('UPLOAD', 'DIRECTORY');

-- CreateEnum
CREATE TYPE "ModelFileScanStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "model_file_scans" (
    "id" TEXT NOT NULL,
    "source" "ModelFileScanSource" NOT NULL,
    "path" TEXT NOT NULL,
    "targetId" TEXT,
    "status" "ModelFileScanStatus" NOT NULL,
    "error" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "files" JSONB,
    "aibom" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_file_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_file_findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "riskCategory" TEXT NOT NULL DEFAULT '组件安全',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_file_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_file_scans_targetId_createdAt_idx" ON "model_file_scans"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "model_file_scans_createdAt_idx" ON "model_file_scans"("createdAt");

-- CreateIndex
CREATE INDEX "model_file_findings_scanId_idx" ON "model_file_findings"("scanId");

-- CreateIndex
CREATE INDEX "model_file_findings_severity_idx" ON "model_file_findings"("severity");

-- AddForeignKey
ALTER TABLE "model_file_scans" ADD CONSTRAINT "model_file_scans_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "model_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_file_scans" ADD CONSTRAINT "model_file_scans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_file_findings" ADD CONSTRAINT "model_file_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "model_file_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
