-- 新增文件库，不变更已有扫描记录；历史扫描的 uploadId 保持为空。
CREATE TYPE "ModelFileUploadStatus" AS ENUM ('UPLOADING', 'READY', 'DELETED');

CREATE TABLE "model_file_uploads" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "expectedBytes" BIGINT,
    "sha256" TEXT,
    "status" "ModelFileUploadStatus" NOT NULL DEFAULT 'UPLOADING',
    "storedPath" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "model_file_uploads_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "model_file_scans" ADD COLUMN "uploadId" TEXT;
CREATE INDEX "model_file_uploads_status_updatedAt_idx" ON "model_file_uploads"("status", "updatedAt");
CREATE INDEX "model_file_uploads_createdById_createdAt_idx" ON "model_file_uploads"("createdById", "createdAt");
CREATE INDEX "model_file_scans_uploadId_createdAt_idx" ON "model_file_scans"("uploadId", "createdAt");
ALTER TABLE "model_file_uploads" ADD CONSTRAINT "model_file_uploads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "model_file_scans" ADD CONSTRAINT "model_file_scans_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "model_file_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
