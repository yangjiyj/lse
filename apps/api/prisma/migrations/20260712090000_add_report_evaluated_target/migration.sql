-- Freeze the evaluated model target on each generated report.  The task target is
-- the bare A side for protected red-team tasks and cannot be used for report
-- ownership or trend grouping.
ALTER TABLE "reports" ADD COLUMN "evaluatedTargetId" TEXT;

CREATE INDEX "reports_evaluatedTargetId_createdAt_idx"
  ON "reports"("evaluatedTargetId", "createdAt");

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_evaluatedTargetId_fkey"
  FOREIGN KEY ("evaluatedTargetId") REFERENCES "model_targets"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
