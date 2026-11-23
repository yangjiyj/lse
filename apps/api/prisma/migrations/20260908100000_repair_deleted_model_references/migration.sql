-- Repair role references left behind by model targets deleted by older releases.
-- The migration changes only orphaned, non-empty string references and records
-- exactly which fields were cleared. Valid settings and historical data remain intact.
WITH reference_fields(setting_key, fields) AS (
  VALUES
    (
      'redteam.config',
      ARRAY[
        'gatewayTargetId',
        'attackerTargetId',
        'secondaryAttackerTargetId',
        'judgeTargetId'
      ]::TEXT[]
    ),
    (
      'agent_eval.config',
      ARRAY['attackerTargetId', 'judgeTargetId']::TEXT[]
    )
),
orphaned AS (
  SELECT
    setting."key",
    ARRAY(
      SELECT field
      FROM unnest(reference_fields.fields) AS field
      WHERE jsonb_typeof(setting."value" -> field) = 'string'
        AND setting."value" ->> field <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM "model_targets" target
          WHERE target."id" = setting."value" ->> field
        )
      ORDER BY field
    ) AS cleared_fields
  FROM "system_settings" setting
  JOIN reference_fields
    ON reference_fields.setting_key = setting."key"
  WHERE jsonb_typeof(setting."value") = 'object'
),
repaired AS (
  UPDATE "system_settings" setting
  SET
    "value" = setting."value" || (
      SELECT jsonb_object_agg(field, to_jsonb(''::TEXT))
      FROM unnest(orphaned.cleared_fields) AS field
    ),
    "updatedById" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  FROM orphaned
  WHERE setting."key" = orphaned."key"
    AND cardinality(orphaned.cleared_fields) > 0
  RETURNING setting."key", orphaned.cleared_fields
)
INSERT INTO "audit_logs" (
  "id",
  "actorName",
  "action",
  "targetType",
  "targetId",
  "detail"
)
SELECT
  CASE repaired."key"
    WHEN 'redteam.config' THEN '6ec0eb52-2a87-4d34-8be8-202609081001'
    ELSE '6ec0eb52-2a87-4d34-8be8-202609081002'
  END,
  '系统升级',
  'system_setting.repair_deleted_model_references',
  'system_setting',
  repaired."key",
  jsonb_build_object(
    'migration', '20260908100000_repair_deleted_model_references',
    'clearedFields', to_jsonb(repaired.cleared_fields)
  )
FROM repaired;
