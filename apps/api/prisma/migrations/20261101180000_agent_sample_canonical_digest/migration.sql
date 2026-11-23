ALTER TABLE "agent_sample_versions" ADD COLUMN "legacyDigest" TEXT;

UPDATE "agent_sample_versions"
SET "legacyDigest" = "digest",
    "digest" = 'sha256:' || encode(sha256(convert_to("content"::text, 'UTF8')), 'hex');
