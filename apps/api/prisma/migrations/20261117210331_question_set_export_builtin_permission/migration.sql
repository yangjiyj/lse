-- 2.7.2 内置样本库导出只给平台管理员：新平台级权限点 question_set:export_builtin，只给 admin。
-- 自建库导出仍用 20261117210330 的 question_set:export（平台管理员和租户管理员）。
-- 时间戳接在 210330 后：本线的迁移时间戳段是 2103xx，加 1 分钟会和 W5（210400）撞。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('question_set:export_builtin'), 'question_set:export_builtin', '导出内置样本库', '样本库')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'question_set:export_builtin'
WHERE role."name" = 'admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
