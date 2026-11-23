import './env.js';
import { z } from 'zod';

export function resolveLicenseEnforce(env: {
  NODE_ENV?: 'development' | 'production' | 'test';
  LICENSE_ENFORCE?: 'true' | 'false';
}): boolean {
  if (env.LICENSE_ENFORCE === undefined) return true;
  return env.LICENSE_ENFORCE === 'true';
}

export function licenseEnforcePolicyError(env: {
  NODE_ENV: 'development' | 'production' | 'test';
  LICENSE_ENFORCE: boolean;
}): string | null {
  if (env.NODE_ENV === 'production' && !env.LICENSE_ENFORCE) {
    return 'LICENSE_ENFORCE=false is not allowed when NODE_ENV=production';
  }
  return null;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 chars'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  CORS_ORIGIN: z.string().default('*'),
  LICENSE_PUBLIC_KEY: z.string().default(''),
  LICENSE_PUBLIC_KEYS: z.string().default(''),
  LICENSE_DEPLOYMENT_ID: z.string().default(''),
  LICENSE_REVOCATION_FILE: z.string().default(''),
  PDF_CJK_FONT_PATH: z.string().default(''),
  PDF_CJK_FONT_FAMILY: z.string().default(''),
  // 报告渲染器：html（默认，HTML/CSS + paged.js + 无头 chromium）| pdfkit（显式选择的兼容渲染器）
  REPORT_RENDERER: z.enum(['pdfkit', 'html']).default('html'),
  // html 渲染器使用的 chromium 可执行路径（当前镜像为 /opt/lse-chromium/chrome）
  REPORT_CHROMIUM_PATH: z.string().default(''),
  LICENSE_ENFORCE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => resolveLicenseEnforce({ LICENSE_ENFORCE: v })),
  RELAY_AUDIT_CHECKER_URL: z.string().url().default('http://localhost:8000'),
  SERVICE_ASSURANCE_SCOPE_POLICIES: z.string().default(''),
  RELAY_AUDIT_SCOPE_POLICY_REF: z.string().trim().min(1).default('relay-audit'),
  PYTHON_JUDGE_URL: z.string().default('http://localhost:8000'),
  PYTHON_JUDGE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GARAK_URL: z.string().default('http://localhost:8092'),
  GARAK_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PYRIT_URL: z.string().default('http://localhost:8093'),
  PYRIT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENHANCE_LLM_BASE_URL: z.string().default(''),
  ENHANCE_LLM_API_KEY: z.string().default(''),
  ENHANCE_LLM_MODEL: z.string().default(''),
  ENHANCE_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  ENHANCE_LLM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // GB/T 45654 题库每月出题、关键词每周补充的定时任务：默认关，题库随产品版本发布；设为 true 才注册定时。
  BANK_AUTO_UPDATE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LLM_JUDGE_BASE_URL: z.string().default(''),
  LLM_JUDGE_API_KEY: z.string().default(''),
  LLM_JUDGE_MODEL: z.string().default(''),
  LLM_JUDGE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Phase2：仅对弱类（应拒答/合规）注入判定 rubric 的开关；默认关，线上零影响。
  LLM_JUDGE_RUBRIC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // 模型文件扫描：部署级目录白名单（逗号分隔，与管理员页面配置取并集），默认对应 compose 只读挂载 /models
  MODEL_SCAN_ROOTS: z.string().default('/models'),
  // 服务器（宿主机）上对应 /models 的目录，仅用于在界面上告诉用户“模型该放哪”；compose 与挂载用同一个变量，缺省时界面只显示容器内路径。
  MODEL_SCAN_HOST_DIR: z.string().default(''),
  // 模型文件可选硬上限（字节），0 表示不限制；上传落盘到 MODEL_SCAN_UPLOAD_DIR（api 与 worker 需共享）
  MODEL_SCAN_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0),
  MODEL_SCAN_UPLOAD_DIR: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const licenseEnforceError = licenseEnforcePolicyError(parsed.data);
if (licenseEnforceError) {
  console.error(`[config] ${licenseEnforceError}`);
  process.exit(1);
}
if (parsed.data.NODE_ENV !== 'production' && process.env.LICENSE_ENFORCE === 'false') {
  console.warn(`[config] LICENSE_ENFORCE=false accepted for ${parsed.data.NODE_ENV} only`);
}

export const config = parsed.data;
export type Config = typeof config;
