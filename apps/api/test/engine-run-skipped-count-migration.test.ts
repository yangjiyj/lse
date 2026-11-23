import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const migrationUrl = new URL(
  '../prisma/migrations/20260711193000_add_engine_run_skipped_count/migration.sql',
  import.meta.url,
);

const LEGACY_RAW_OUTPUT_PATTERN = String.raw`^\{"engine":"[A-Za-z0-9._:@/-]+","judged":(?:0|[1-9][0-9]*),"failed":(?:0|[1-9][0-9]*),"skipped":(0|[1-9][0-9]{0,9})(?:,"source":"question_semantic_metadata")?\}$`;

const LEGACY_BACKFILL_SQL = String.raw`WITH "legacy_engine_run_skips" AS (
  SELECT
    "id",
    substring(
      "rawOutput"
      FROM '${LEGACY_RAW_OUTPUT_PATTERN}'
    ) AS "skipped"
  FROM "engine_runs"
)
UPDATE "engine_runs" AS "run"
SET "skippedCount" = "legacy"."skipped"::INTEGER
FROM "legacy_engine_run_skips" AS "legacy"
WHERE "run"."id" = "legacy"."id"
  AND "legacy"."skipped" IS NOT NULL
  AND "legacy"."skipped"::BIGINT <= 2147483647;`;

test('skippedCount migration snapshots safe legacy aggregate backfill SQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.ok(
    sql.includes(LEGACY_BACKFILL_SQL),
    'migration must backfill skippedCount from the legacy aggregate rawOutput',
  );
  assert.doesNotMatch(
    sql,
    /"rawOutput"\s*::\s*jsonb/i,
    'malformed historical text must not abort the migration',
  );
});

test('legacy aggregate matcher accepts non-negative integers and rejects unsafe text', () => {
  const matcher = new RegExp(LEGACY_RAW_OUTPUT_PATTERN);

  assert.equal(
    matcher.exec('{"engine":"rule-judge","judged":41,"failed":0,"skipped":3}')?.[1],
    '3',
  );
  assert.equal(
    matcher.exec(
      '{"engine":"semantic-input-risk","judged":40,"failed":0,"skipped":44,"source":"question_semantic_metadata"}',
    )?.[1],
    '44',
  );
  assert.equal(matcher.exec('{"engine":"rule-judge","judged":1,"failed":0,"skipped":0}')?.[1], '0');

  assert.equal(matcher.test('not-json "skipped":9'), false);
  assert.equal(matcher.test('{"engine":"rule-judge","judged":1,"failed":0}'), false);
  assert.equal(matcher.test('{"engine":"rule-judge","judged":1,"failed":0,"skipped":-1}'), false);
  assert.equal(matcher.test('{"engine":"rule-judge","judged":1,"failed":0,"skipped":01}'), false);
  assert.equal(matcher.test('{"engine":"rule-judge","judged":1,"failed":0,"skipped":"1"}'), false);
  assert.equal(matcher.test('{"skipped":9}'), false);
});
