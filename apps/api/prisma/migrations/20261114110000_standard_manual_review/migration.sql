-- GB/T 45654 人工抽检工作台与第 6 章措施核验（车道 C2）。

CREATE TABLE "standard_manual_reviews" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "slot" INTEGER NOT NULL DEFAULT 1,
  "reviewerId" TEXT NOT NULL,
  "reviewerName" TEXT NOT NULL,
  "verdict" TEXT NOT NULL,
  "itemCode" TEXT,
  "note" TEXT,
  "classifierLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "standard_manual_reviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "standard_manual_reviews_sampleId_slot_key" ON "standard_manual_reviews"("sampleId", "slot");
CREATE INDEX "standard_manual_reviews_runId_slot_idx" ON "standard_manual_reviews"("runId", "slot");
CREATE INDEX "standard_manual_reviews_runId_reviewerId_idx" ON "standard_manual_reviews"("runId", "reviewerId");

CREATE TABLE "standard_measure_checks" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "clauseId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "evidence" JSONB,
  "verdict" TEXT,
  "note" TEXT,
  "materials" TEXT,
  "confirmedById" TEXT,
  "confirmedByName" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "standard_measure_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "standard_measure_checks_runId_clauseId_key" ON "standard_measure_checks"("runId", "clauseId");
CREATE INDEX "standard_measure_checks_runId_idx" ON "standard_measure_checks"("runId");

-- 跟随标准专项运行一起清理（删除任务时运行被删，复核与核验记录随之清掉）。
ALTER TABLE "standard_manual_reviews" ADD CONSTRAINT "standard_manual_reviews_runId_fkey" FOREIGN KEY ("runId") REFERENCES "standard_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standard_measure_checks" ADD CONSTRAINT "standard_measure_checks_runId_fkey" FOREIGN KEY ("runId") REFERENCES "standard_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
