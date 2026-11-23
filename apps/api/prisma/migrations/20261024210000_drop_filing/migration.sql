-- 下线备案材料功能：删除关键词库、备案材料包、符合性覆写、人工抽检与单位信息五张表。
-- 部署前已单独导出这五张表的数据，回滚见同目录 down.sql（只恢复表结构）。
DROP TABLE IF EXISTS "filing_manual_sampling";
DROP TABLE IF EXISTS "filing_organizations";
DROP TABLE IF EXISTS "filing_compliance_overrides";
DROP TABLE IF EXISTS "filing_packages";
DROP TABLE IF EXISTS "keywords";
DROP TABLE IF EXISTS "keyword_libraries";
