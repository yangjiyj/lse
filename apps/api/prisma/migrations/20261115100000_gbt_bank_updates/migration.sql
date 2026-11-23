-- GB/T 45654 题库与关键词库更新记录（平台级，不分租户）。
CREATE TABLE "gbt_bank_updates" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "actorName" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "added" JSONB,
  "retired" JSONB,
  "totals" JSONB,
  "generatorModel" TEXT,
  "judgeModel" TEXT,
  "note" TEXT,
  "error" TEXT,
  CONSTRAINT "gbt_bank_updates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gbt_bank_updates_kind_startedAt_idx" ON "gbt_bank_updates"("kind", "startedAt");
