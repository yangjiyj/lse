-- AlterTable
ALTER TABLE "engine_runs"
  ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill only the exact legacy aggregate JSON shape without casting arbitrary text to JSONB.
WITH "legacy_engine_run_skips" AS (
  SELECT
    "id",
    substring(
      "rawOutput"
      FROM '^\{"engine":"[A-Za-z0-9._:@/-]+","judged":(?:0|[1-9][0-9]*),"failed":(?:0|[1-9][0-9]*),"skipped":(0|[1-9][0-9]{0,9})(?:,"source":"question_semantic_metadata")?\}$'
    ) AS "skipped"
  FROM "engine_runs"
)
UPDATE "engine_runs" AS "run"
SET "skippedCount" = "legacy"."skipped"::INTEGER
FROM "legacy_engine_run_skips" AS "legacy"
WHERE "run"."id" = "legacy"."id"
  AND "legacy"."skipped" IS NOT NULL
  AND "legacy"."skipped"::BIGINT <= 2147483647;

-- CreateIndex
CREATE INDEX "engine_runs_taskId_status_skippedCount_idx"
  ON "engine_runs"("taskId", "status", "skippedCount");
