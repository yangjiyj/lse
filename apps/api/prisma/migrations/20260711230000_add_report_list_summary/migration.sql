ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "listSummary" JSONB;

WITH "legacy_reports" AS (
  SELECT
    "id",
    CASE
      WHEN jsonb_typeof("summary") = 'object' THEN "summary"
      ELSE '{}'::jsonb
    END AS "legacySummary"
  FROM "reports"
)
UPDATE "reports" AS "report"
SET "listSummary" = jsonb_strip_nulls(
  jsonb_build_object(
    'kind', COALESCE(NULLIF("legacy"."legacySummary" -> 'kind', 'null'::jsonb), to_jsonb("report"."kind")),
    'headline', "legacy"."legacySummary" -> 'headline',
    'metrics', "legacy"."legacySummary" -> 'metrics',
    'totalQuestions', COALESCE("legacy"."legacySummary" -> 'totalQuestions', to_jsonb("report"."totalQuestions")),
    'processedQuestions', "legacy"."legacySummary" -> 'processedQuestions',
    'passedCount', "legacy"."legacySummary" -> 'passedCount',
    'failedCount', "legacy"."legacySummary" -> 'failedCount',
    'errorCount', "legacy"."legacySummary" -> 'errorCount',
    'wrongAnswerCount', "legacy"."legacySummary" -> 'wrongAnswerCount',
    'evidenceFindingCount', "legacy"."legacySummary" -> 'evidenceFindingCount',
    'findingCount', "legacy"."legacySummary" -> 'findingCount',
    'securityScore', "legacy"."legacySummary" -> 'securityScore',
    'verdictDistribution', "legacy"."legacySummary" -> 'verdictDistribution',
    'severityDistribution', "legacy"."legacySummary" -> 'severityDistribution',
    'explanationRun', "legacy"."legacySummary" -> 'explanationRun'
  )
)
FROM "legacy_reports" AS "legacy"
WHERE "report"."id" = "legacy"."id"
  AND "report"."listSummary" IS NULL;
