-- 鉴盾对标二期 D：组织架构权限点（2.9.3）。与 packages/shared/src/permissions.ts 的 ROLE_DEFS 一致：
-- org:read 给全部内置角色；org:manage 给平台管理员和租户管理员（租户内权限，不是平台级）。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('org:read'), 'org:read', '查看组织架构', '组织架构'),
  (md5('org:manage'), 'org:manage', '维护组织架构', '组织架构')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'org:read'
WHERE role."name" IN ('admin', 'tenant_admin', 'operator', 'auditor')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'org:manage'
WHERE role."name" IN ('admin', 'tenant_admin')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
