CREATE TYPE "FindingRemediationStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'READY_FOR_RETEST', 'VERIFIED_CLOSED', 'REOPENED', 'NOT_APPLICABLE');

ALTER TABLE "findings"
  ADD COLUMN "remediationStatus" "FindingRemediationStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "remediationOwner" TEXT,
  ADD COLUMN "remediationTeam" TEXT,
  ADD COLUMN "remediationLocation" TEXT,
  ADD COLUMN "remediationAction" TEXT,
  ADD COLUMN "remediationDueAt" TIMESTAMP(3),
  ADD COLUMN "remediationRecord" TEXT,
  ADD COLUMN "remediationAcceptanceCriteria" TEXT,
  ADD COLUMN "remediationRetestTaskId" TEXT,
  ADD COLUMN "remediationClosureEvidence" TEXT,
  ADD COLUMN "remediationClosedAt" TIMESTAMP(3);

CREATE INDEX "findings_remediationStatus_remediationDueAt_idx"
  ON "findings"("remediationStatus", "remediationDueAt");

ALTER TABLE "findings"
  ADD CONSTRAINT "findings_remediationRetestTaskId_fkey"
  FOREIGN KEY ("remediationRetestTaskId") REFERENCES "eval_tasks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
