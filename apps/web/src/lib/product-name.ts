/**
 * 产品名单一来源（前端）。运行时代码一律引用这里，禁止再写死字面量
 *（product-name.test.ts 会扫描源码拦截）。
 *
 * 命名规则：
 * - PRODUCT_NAME「鉴盾」：给客户在界面/报告上看到的品牌名（顶栏、封面、水印、Excel 创建者）。
 * - PRODUCT_FULL_NAME「大模型安全评估平台」：需要描述性名称的位置（系统提示词、备案材料、
 *   RAG 文档说明、CI 导出工具名等）。
 * - DEFAULT_PLATFORM_TITLE_TEXT：默认页签/报告页脚/封面标题 =「鉴盾 · 大模型安全评估平台」。
 *
 * 改名清单：本文件、api/src/lib/product-name.ts，
 * 以及无法引用常量的 apps/web/index.html（<title>，由 product-name.test.ts 校验一致）、 README.md、package.json（description）、
 * Dockerfile / Caddyfile / schema.prisma / 离线包脚本 / docs 的说明文字。
 */
export const PRODUCT_NAME = '鉴盾';
/** 全称：描述性名称（系统提示词、备案材料、文档说明）。 */
export const PRODUCT_FULL_NAME = '大模型安全评估平台';
/** 英文副标。 */
export const PRODUCT_NAME_EN = 'AI Safety Assessment';
/** 默认平台标题（页签、报告页脚、封面）：品牌名 · 全称。 */
export const DEFAULT_PLATFORM_TITLE_TEXT = `${PRODUCT_NAME} · ${PRODUCT_FULL_NAME}`;
