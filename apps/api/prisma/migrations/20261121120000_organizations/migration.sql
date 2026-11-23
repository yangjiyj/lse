-- 鉴盾对标二期 D：组织架构（2.9.3）与用户绑定组织（2.9.1）。
-- 组织树在租户内（tenant-models.ts 的 owned 清单）；最多 8 级由接口校验；删除时有下级或成员就拒绝，不级联。

CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "organizations_tenantId_idx" ON "organizations"("tenantId");
CREATE INDEX "organizations_parentId_idx" ON "organizations"("parentId");
-- 同一上级下不重名，不分大小写（名称入库前已由接口规范化：去零宽和控制字符、NFKC、去首尾空白）。
-- 根节点的 parentId 为空，NULL 互不相等，第一条索引管不到根节点，第二条单独用部分唯一索引。
-- Prisma 写不出表达式索引和部分索引，schema.prisma 里没有这两条。
CREATE UNIQUE INDEX "organizations_tenantId_parentId_lower_name_key" ON "organizations"("tenantId", "parentId", lower("name"));
CREATE UNIQUE INDEX "organizations_tenantId_lower_name_root_key" ON "organizations"("tenantId", lower("name")) WHERE "parentId" IS NULL;

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 用户所属组织。与 W1 自助注册填的「单位」（users.organization，自由文本）无关。
ALTER TABLE "users" ADD COLUMN "organizationId" TEXT;
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 没带租户写入时跟随上级组织，推不出来归平台租户；上级、用户所属组织都不许跨租户（与 multi_tenant 迁移的写法一致）。
CREATE TRIGGER "lse_tenant_10_fill" BEFORE INSERT ON "organizations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_fill('organizations:parentId', '@default');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "parentId" ON "organizations" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('organizations:parentId');
CREATE TRIGGER "lse_tenant_20_guard" BEFORE INSERT OR UPDATE OF "tenantId", "organizationId" ON "users" FOR EACH ROW EXECUTE FUNCTION lse_tenant_guard('organizations:organizationId');
