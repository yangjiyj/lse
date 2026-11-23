-- 2.7.2 样本库导出：新权限点 question_set:export，只给平台管理员和租户管理员
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('question_set:export'), 'question_set:export', '导出样本库', '样本库')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'question_set:export'
WHERE role."name" IN ('admin', 'tenant_admin')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
