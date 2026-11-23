-- 模型文件扫描返工：队列化状态/进度、部分结果标注、模型文件问题复核与整改字段。
-- 全部为新增枚举值 / 可空列 / 带默认值列，对现网已有数据安全（历史记录保持 COMPLETED/FAILED）。

-- AlterEnum
ALTER TYPE "ModelFileScanStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "ModelFileScanStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "ModelFileScanStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "model_file_scans"
  ADD COLUMN "request" JSONB,
  ADD COLUMN "progressFiles" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "progressBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "plannedFiles" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "plannedBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "truncatedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "truncatedReason" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "model_file_findings"
  ADD COLUMN "reviewStatus" "FindingReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "remediationStatus" "FindingRemediationStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "remediationOwner" TEXT,
  ADD COLUMN "remediationAction" TEXT,
  ADD COLUMN "remediationDueAt" TIMESTAMP(3),
  ADD COLUMN "remediationRecord" TEXT,
  ADD COLUMN "remediationClosureEvidence" TEXT,
  ADD COLUMN "remediationRetestScanId" TEXT,
  ADD COLUMN "remediationClosedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "model_file_findings_reviewStatus_idx" ON "model_file_findings"("reviewStatus");
CREATE INDEX "model_file_findings_remediationStatus_remediationDueAt_idx" ON "model_file_findings"("remediationStatus", "remediationDueAt");
