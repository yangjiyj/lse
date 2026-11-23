-- P0 false-positive governance: make AI/manual review state first-class on findings.
CREATE TYPE "FindingReviewStatus" AS ENUM (
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK'
);

ALTER TABLE "findings"
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "reviewStatus" "FindingReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "suppressionKey" TEXT;

CREATE INDEX "findings_taskId_reviewStatus_idx" ON "findings"("taskId", "reviewStatus");
CREATE INDEX "findings_suppressionKey_idx" ON "findings"("suppressionKey");
