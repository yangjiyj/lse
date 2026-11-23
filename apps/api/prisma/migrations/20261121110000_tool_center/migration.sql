-- 工具中心（2.3.1～2.3.6、2.3.8～2.3.10）：工具、版本、手册、下载记录。
-- 工具是平台级内容，所有租户共用，表里不带 tenantId；下载记录带下载人所属租户，只用于溯源展示。
-- 内置「终端探针」由 seed 建（prisma/seed.ts → ensureBuiltinTools）。

CREATE TABLE "tools" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "instructions" TEXT NOT NULL DEFAULT '',
    "configParams" JSONB NOT NULL DEFAULT '[]',
    "taskEntry" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tool_versions" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "releaseNotes" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tool_manuals" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_manuals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tool_downloads" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "versionId" TEXT,
    "manualId" TEXT,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "tenantId" TEXT,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "filename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_downloads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tools_code_key" ON "tools"("code");
CREATE UNIQUE INDEX "tool_versions_storageKey_key" ON "tool_versions"("storageKey");
CREATE UNIQUE INDEX "tool_versions_toolId_version_os_arch_key" ON "tool_versions"("toolId", "version", "os", "arch");
CREATE UNIQUE INDEX "tool_manuals_storageKey_key" ON "tool_manuals"("storageKey");
CREATE INDEX "tool_manuals_toolId_idx" ON "tool_manuals"("toolId");
CREATE INDEX "tool_downloads_toolId_createdAt_idx" ON "tool_downloads"("toolId", "createdAt");
CREATE INDEX "tool_downloads_userId_createdAt_idx" ON "tool_downloads"("userId", "createdAt");

ALTER TABLE "tools" ADD CONSTRAINT "tools_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tool_manuals" ADD CONSTRAINT "tool_manuals_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_manuals" ADD CONSTRAINT "tool_manuals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tool_downloads" ADD CONSTRAINT "tool_downloads_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tool_downloads" ADD CONSTRAINT "tool_downloads_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "tool_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tool_downloads" ADD CONSTRAINT "tool_downloads_manualId_fkey" FOREIGN KEY ("manualId") REFERENCES "tool_manuals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tool_downloads" ADD CONSTRAINT "tool_downloads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 权限：tool:read 给全部预设角色；tool:manage 只给平台管理员（平台级权限）。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('tool:read'), 'tool:read', '查看工具中心', '工具中心'),
  (md5('tool:manage'), 'tool:manage', '管理工具中心', '工具中心')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'tool:read'
WHERE role."name" IN ('admin', 'tenant_admin', 'operator', 'auditor')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'tool:manage'
WHERE role."name" = 'admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
