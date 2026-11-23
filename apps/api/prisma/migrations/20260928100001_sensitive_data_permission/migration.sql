-- 第 16 条数据安全：「查看明文」权限（默认仅内置管理员拥有）
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('sensitive_data:view_plain'), 'sensitive_data:view_plain', '查看敏感信息明文', '数据安全')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'sensitive_data:view_plain'
WHERE role."name" = 'admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
