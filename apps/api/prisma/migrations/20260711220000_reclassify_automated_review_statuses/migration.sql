-- Historical CONFIRMED/FALSE_POSITIVE values were produced by the automated
-- review chain before a human review write path existed. Reclassify them so
-- the stored authority matches their actual provenance.
UPDATE "findings"
SET
  "reviewReason" = (
    CASE
      WHEN "reviewStatus" = 'CONFIRMED' THEN
        '历史自动复核纠偏：原“确认风险”状态由自动判定链生成，不代表人工确认风险；已调整为待人工复核。'
      ELSE
        '历史自动复核纠偏：原“确认误报”状态由自动判定链生成，不代表人工确认误报；已调整为待人工复核。'
    END
    || CASE
      WHEN NULLIF(BTRIM("reviewReason"), '') IS NULL THEN ''
      ELSE E'\n原复核理由：' || "reviewReason"
    END
  ),
  "reviewStatus" = 'NEEDS_REVIEW'
WHERE "reviewStatus" IN ('CONFIRMED', 'FALSE_POSITIVE');
