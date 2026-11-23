-- Definition only: no persistent identity or grants to existing roles.
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('platform_connector:restricted'), 'platform_connector:restricted', 'Platform connector restricted scope', 'Product connectors')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";
