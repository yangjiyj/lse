import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError, badRequest, notFound } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { prisma } from '../../../db.js';
import { authenticate, requirePermission } from '../../../plugins/auth.js';
import { summarizeTargetEgressPolicy } from '../../../lib/target-egress-policy.js';
import { ArchiveError } from './archive.js';
import { intakeUpload } from './intake.js';
import { componentExtraHits, fetchEndpointSnapshot, MCP_FETCH_AVAILABLE, updateToolBaselines } from './integrations.js';
import {
  AI_COMPONENT_UPLOAD_MAX_BYTES,
  persistFailedScan,
  runAndPersistScan,
  sha256Hex,
  unpackInput,
  type ScanRequestMeta,
} from './service.js';
import { registerAiComponentQueryRoutes } from './component-query-routes.js';

export const ASSET_TYPES = ['SKILL', 'MCP', 'PLUGIN'] as const;
const SCAN_OPTS = { extra: componentExtraHits, onPersisted: updateToolBaselines };

const metaSchema = z.object({
  assetName: z.string().trim().min(1, '请填写资产名称').max(200),
  assetType: z.enum(ASSET_TYPES),
  assetVersion: z.string().trim().max(100).optional(),
  sourceLabel: z.string().trim().max(500).optional(),
});
const uploadQuery = metaSchema.extend({
  fileName: z.string().trim().min(1).max(255),
  mode: z.enum(['UPLOAD', 'ARCHIVE']).default('ARCHIVE'),
});
const endpointBody = metaSchema
  .extend({
    url: z.string().trim().url('MCP 服务地址格式不正确').max(2000),
    /** 可选鉴权头：仅用于本次拉取，不落库、不写日志、不回显 */
    headers: z.record(z.string().max(100), z.string().max(4000)).optional(),
  })
  .strict();

function audit(req: FastifyRequest, action: string, targetId: string, detail: Record<string, unknown>) {
  return writeAudit({
    actorId: req.currentUser!.id,
    actorName: req.currentUser!.username,
    action,
    targetType: 'ai_component_scan',
    targetId,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    detail,
  });
}

/** 去掉用户信息、查询串与片段后再落库/写审计（查询串里可能带令牌） */
export function redactEndpoint(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '（地址格式不正确）';
  }
}

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ArchiveError) return badRequest(e.message, e.code);
  if (e instanceof Error && e.name === 'McpFetchError') return badRequest(e.message, (e as Error & { code?: string }).code ?? 'MCP_FETCH_FAILED');
  return badRequest(e instanceof Error ? e.message : '扫描失败', 'AI_COMPONENT_SCAN_FAILED');
}

const MIB = 1024 * 1024;
/** 上传解析错误转中文：超限 413、类型不对 415；其余交上层统一处理 */
export function uploadErrorHandler(err: FastifyError): never {
  if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
    throw new AppError(413, `上传内容超过上限 ${Math.round(AI_COMPONENT_UPLOAD_MAX_BYTES / MIB)} MiB，请精简后重试（上限由 AI_COMPONENT_UPLOAD_MAX_BYTES 配置）`, 'AI_COMPONENT_UPLOAD_TOO_LARGE', { maxBytes: AI_COMPONENT_UPLOAD_MAX_BYTES });
  }
  if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
    throw new AppError(415, '上传需使用 Content-Type: application/octet-stream', 'AI_COMPONENT_UPLOAD_MEDIA_TYPE');
  }
  throw err;
}

function userMeta(req: FastifyRequest) {
  return { userId: req.currentUser!.id, userName: req.currentUser!.username };
}

export async function registerAiComponentRoutes(app: FastifyInstance): Promise<void> {
  // 原始二进制上传：只在本插件作用域内注册 octet-stream 解析器
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: AI_COMPONENT_UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get('/ai-components/config', { preHandler: [requirePermission('engine:scan', 'eval_task:read')] }, async () => ({
    uploadMaxBytes: AI_COMPONENT_UPLOAD_MAX_BYTES,
    archiveFormats: ['zip', 'tar', 'tgz'],
    mcpFetch: {
      ...(MCP_FETCH_AVAILABLE
        ? { available: true, transports: ['streamable-http', 'sse'] }
        : { available: false, reason: 'MCP 在线拉取模块尚未启用，请先上传源码或工具定义文件' }),
      // 只回传布尔摘要，不回传允许清单内容
      egress: summarizeTargetEgressPolicy(),
    },
    stdioSupported: false,
    stdioNote: '出于安全原因平台不执行 stdio 命令型 MCP，仅支持上传源码或填写 HTTP 端点',
  }));

  app.post(
    '/ai-components/scans/upload',
    {
      // 在读取请求体之前先鉴权，避免未登录请求占用大体积上传
      onRequest: [authenticate as unknown as onRequestHookHandler],
      preHandler: [requirePermission('engine:scan')],
      bodyLimit: AI_COMPONENT_UPLOAD_MAX_BYTES,
      errorHandler: (err, _req, _reply) => uploadErrorHandler(err),
    },
    async (req, reply) => {
      const q = uploadQuery.parse(req.query);
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('请求体为空：请以 application/octet-stream 上传文件或压缩包', 'AI_COMPONENT_EMPTY_BODY');
      const meta: ScanRequestMeta = {
        assetName: q.assetName,
        assetType: q.assetType,
        assetVersion: q.assetVersion || null,
        sourceType: q.mode,
        sourceLabel: q.sourceLabel || q.fileName,
        contentSha256: sha256Hex(body),
        totalBytes: body.length,
        preSkipped: [],
        ...userMeta(req),
      };
      let id: string;
      try {
        const intake = intakeUpload(body, q.fileName);
        meta.preSkipped = intake.skipped;
        if (!intake.files.length) {
          const reasons = intake.skipped.slice(0, 5).map((s) => `${s.path}：${s.reason}`).join('；');
          const more = intake.skipped.length > 5 ? ` 等 ${intake.skipped.length} 个` : '';
          throw badRequest(`没有可扫描的文本/源码文件（已跳过 ${intake.skipped.length} 个${reasons ? `：${reasons}${more}` : ''}）`, 'AI_COMPONENT_NO_TEXT');
        }
        meta.totalBytes = Math.max(body.length, intake.totalBytes);
        id = await runAndPersistScan(meta, intake.files, SCAN_OPTS);
      } catch (e) {
        const err = toAppError(e);
        const failedId = await persistFailedScan(meta, err.message);
        await audit(req, 'ai_component.scan', failedId, { failed: true, code: err.code, error: err.message, fileName: q.fileName, bytes: body.length });
        throw new AppError(err.statusCode, err.message, err.code, { scanId: failedId });
      }
      await audit(req, 'ai_component.scan', id, { assetName: q.assetName, assetType: q.assetType, mode: q.mode, fileName: q.fileName, bytes: body.length, sha256: meta.contentSha256 });
      return reply.code(201).send({ id });
    },
  );

  app.post('/ai-components/scans/endpoint', { preHandler: [requirePermission('engine:scan')] }, async (req, reply) => {
    const b = endpointBody.parse(req.body);
    if (!MCP_FETCH_AVAILABLE) throw badRequest('MCP 在线拉取模块尚未启用，请先上传源码或工具定义文件', 'AI_COMPONENT_MCP_FETCH_UNAVAILABLE');
    const meta: ScanRequestMeta = {
      assetName: b.assetName,
      assetType: b.assetType,
      assetVersion: b.assetVersion || null,
      sourceType: 'MCP_ENDPOINT',
      sourceLabel: b.sourceLabel || null,
      endpointUrl: redactEndpoint(b.url),
      contentSha256: null,
      totalBytes: 0,
      preSkipped: [],
      ...userMeta(req),
    };
    let id: string;
    try {
      const snap = await fetchEndpointSnapshot(b.url, b.headers ?? {});
      meta.snapshot = snap.snapshot;
      if (typeof snap.snapshot.endpoint === 'string') meta.endpointUrl = snap.snapshot.endpoint;
      meta.contentSha256 = sha256Hex(snap.file.content);
      meta.totalBytes = Buffer.byteLength(snap.file.content, 'utf8');
      id = await runAndPersistScan(meta, [snap.file], SCAN_OPTS);
    } catch (e) {
      const err = toAppError(e);
      const failedId = await persistFailedScan(meta, err.message);
      await audit(req, 'ai_component.mcp_fetch', failedId, { failed: true, code: err.code, error: err.message, host: new URL(b.url).host });
      throw new AppError(err.statusCode, err.message, err.code, { scanId: failedId });
    }
    // 审计只记主机与是否带鉴权头，绝不记录头部内容
    await audit(req, 'ai_component.mcp_fetch', id, { assetName: b.assetName, host: new URL(b.url).host, withAuthHeaders: Object.keys(b.headers ?? {}).length > 0 });
    return reply.code(201).send({ id });
  });

  app.post('/ai-components/scans/:id/rescan', { preHandler: [requirePermission('engine:scan')] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const prev = await prisma.aiComponentScan.findUnique({ where: { id } });
    if (!prev) throw notFound('扫描记录不存在');
    if (prev.sourceType === 'MCP_ENDPOINT') throw badRequest('MCP 服务地址扫描请重新填写地址与鉴权信息发起（平台不保存鉴权头）', 'AI_COMPONENT_RESCAN_ENDPOINT');
    if (!prev.inputBlob) throw badRequest('该记录未保存输入内容（超过快照上限或扫描失败），请重新上传', 'AI_COMPONENT_RESCAN_NO_INPUT');
    const files = unpackInput(prev.inputBlob);
    const newId = await runAndPersistScan(
      {
        assetName: prev.assetName,
        assetType: prev.assetType as ScanRequestMeta['assetType'],
        assetVersion: prev.assetVersion,
        sourceType: prev.sourceType as ScanRequestMeta['sourceType'],
        sourceLabel: prev.sourceLabel,
        contentSha256: prev.contentSha256,
        totalBytes: prev.totalBytes,
        preSkipped: [],
        ...userMeta(req),
      },
      files,
      SCAN_OPTS,
    );
    await audit(req, 'ai_component.rescan', newId, { fromScanId: id, assetName: prev.assetName });
    return reply.code(201).send({ id: newId });
  });

  await registerAiComponentQueryRoutes(app, audit);
}
