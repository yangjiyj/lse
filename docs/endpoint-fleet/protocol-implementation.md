# 鉴盾终端接入协议 · 服务端实现说明（第一期）

> 2026-10-22。对应规格：`protocol-subset.md`（v0.1）。代码：`apps/api/src/modules/fleet-agent/`；测试：`apps/api/test/fleet-agent-unit.test.ts`、`apps/api/test/fleet-agent-routes.test.ts`。

## 1. 实现了什么

`/agent/v1/*` 作为独立 Fastify 插件注册在 `app.ts`（前缀 `/agent/v1`），自带鉴权、错误处理和 404 处理，不走平台登录 JWT，也不影响 `/api/*`。

| 端点 | 鉴权 | 体上限 | 说明 |
| --- | --- | --- | --- |
| `POST /endpoints/register` | 接入码 | 64 KiB | 按 `installation_id` 幂等；新终端在事务内用条件原子更新占用配额 |
| `POST /endpoints/heartbeat` | 终端令牌 | 64 KiB | 保存 `lastHealth`、`evalRunner`、`lastSeenAt` |
| `POST /probe-reports` | 终端令牌 | 8 MiB | §3 全部校验；同 `report_id` 同体哈希返回 `duplicate:true`，体哈希不同返回 409 |
| `GET /policy` | 终端令牌 | — | `{version:1, checksum:"sha256:…"}`；带 `view` 参数返回 404 |
| `GET /credential-deliveries` | 终端令牌 | — | 固定返回 `{"items":[]}` |
| `GET /eval-jobs` | 终端令牌 | — | 最多 1 条；本终端已有 DELIVERED/RUNNING 时返回 `[]` |
| `POST /eval-jobs/:id/ack` | 终端令牌 | 8 KiB | 体必须恰好是 `{checksum}` |
| `POST /eval-jobs/:id/started` | 终端令牌 | 8 KiB | 体必须是 `{}` |
| `POST /eval-jobs/:id/result` | 终端令牌 | 2 MiB | 按 §5.4 校验；不合格时记 `FAILED(invalid_result)` 并返回 409 |
| 其他 `/agent/v1/*` | 终端令牌 | — | 先鉴权，再返回 404 |

处理顺序：开关 → 按 IP 限流 → 鉴权（`onRequest` 阶段，只看请求头）→ 读体（路由级 `bodyLimit`，超限返回 413）→ 校验 → 业务处理。

### 1.1 模块文件

| 文件 | 内容 |
| --- | --- |
| `auth.ts` | `hashSecret`、`generateEnrollmentCode`、`generateEndpointToken`、`generateEndpointPublicId`、`safeEqual`、`parseBearer`、`findUsableEnrollmentCode`、`findEndpointByToken` |
| `checksum.ts` | `canonicalize`、`evalJobChecksum`、`canonicalJobPayload`、`buildJobPayload`、`validateScenarioPack`、`FleetPayloadError` |
| `validate-result.ts` | `validateResult`（移植自 `stub_server.reference.py` 的 `validate_result`）、`InvalidResultError` |
| `hooks.ts` | `registerFleetJobFinishedHook`、`onFleetJobFinished` |
| `rate-limit.ts` | 内存令牌桶 `TokenBucketLimiter`、`noopLimiter` |
| `config.ts` | 开关、限流参数、体积上限 |
| `routes.ts` | `fleetAgentRoutes` 插件 |

### 1.2 给其他车道的接口

```ts
// auth.ts
hashSecret(secret: string): string                 // sha256 小写 hex
generateEnrollmentCode(): string                   // jdc_ + 32 字节 base64url
generateEndpointToken(): string                    // 32 字节小写 hex
// checksum.ts
buildJobPayload(product: string, scenarioPack: unknown, sinkBaseUrl: string): { canonical: string; checksum: string }
validateScenarioPack(pack: unknown): string | null // null 表示通过，否则返回中文原因
// hooks.ts
registerFleetJobFinishedHook(hook: (jobId: string) => void | Promise<void>): () => void
```

- 管理接口创建任务时，把 `buildJobPayload` 返回的 `canonical` 存入 `FleetEvalJob.payloadCanonical`、`checksum` 存入 `checksum`，`product` 列要与 payload 一致。下发时，服务端会自检 `sha256(payloadCanonical) == checksum` 并核对 `product`，不一致的任务跳过不下发。
- 钩子收到的 `jobId` 是 `FleetEvalJob.id`（内部 UUID），不是 `publicId`。钩子在任务进入 COMPLETED/FAILED 之后异步调用，抛错只记日志，不影响返回给采集器的应答。

## 2. 错误码表

错误响应体统一为 `{"error":"<code>"}`，不细分原因。采集器不读错误体，只看状态码。

| 状态码 | `error` | 场景 |
| --- | --- | --- |
| 400 | `invalid_request` | 体不是 JSON 对象、登记字段不合法、probe-reports 带查询串、字符串含 NUL |
| 401 | `unauthorized` | 终端令牌缺失、错误或已吊销；心跳 `endpoint_id` 与令牌不符 |
| 401 | `endpoint_mismatch` | probe-reports 的 `endpoint_id` 与令牌不符 |
| 403 | `enrollment_rejected` | 接入码缺失、无效、过期、撤销或已满；`installation_id` 对应的 machine_id 或接入码不一致；该终端已吊销 |
| 404 | `not_found` | 开关关闭；未实现端点；任务不存在或不属于本终端；`job_id` 不合规；`/policy?view=…` |
| 409 | `report_conflict` | 同一 `report_id`、不同体哈希 |
| 409 | `conflict` | 状态机转移非法、checksum 不等、超过 deadline（result 为 deadline + 10 分钟） |
| 409 | `invalid_result` | result 校验失败（任务已记为 `FAILED`，`errorCode=invalid_result`） |
| 413 | `payload_too_large` | 超过体积上限 |
| 415 | `unsupported_media_type` | probe-reports 的 Content-Type 不是 `application/json` |
| 422 | `invalid_report` | probe-reports 的 schema_version、scanned_at、report_id、status、assets/collectors 不合规 |
| 429 | `rate_limited` | 触发限流 |
| 500 | `internal` | 未预期错误（只记录错误类型和消息） |

## 3. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FLEET_AGENT_ENABLED` | `false` | 总开关。关闭时 `/agent/v1/*` 一律返回 404。每次请求时读取 |
| `FLEET_AGENT_IP_RATE_PER_MIN` | `600` | 每个来源 IP 每分钟的请求数，在鉴权前计数 |
| `FLEET_AGENT_REGISTER_RATE_PER_MIN` | `20` | 每个来源 IP 每分钟的登记次数，用于防接入码爆破 |
| `FLEET_AGENT_ENDPOINT_RATE_PER_MIN` | `120` | 每个终端每分钟的请求数。采集器正常约 4 次/分钟 |

上面这些变量在 `modules/fleet-agent/config.ts` 中按请求读取（与 `endpoint-evals/config.ts` 的做法一致），没有加进 `src/config.ts`。原因见 §4。

## 4. 与规格的差异和取舍

1. **register 缺少 Bearer 返回 403，不返回 401**：规格把「接入码无效」统一定为 403，这里把「缺失或格式错误」也并入同一个 403，对外只有一种拒绝应答。
2. **`installation_id` 必填**：参考实现允许为空，规格写的是「规范小写 UUIDv4」，而且数据模型里 `installationId` 是唯一且非空的列。真实采集器总会发送这个字段。
3. **同一 `installation_id` 换接入码重新登记会被拒绝（403）**：规格只要求「同码」时幂等。换码时，如果复用原终端，旧码的配额归属会变得不清楚；如果新建终端，又会违反唯一约束，所以直接拒绝。已吊销的终端用原 installation 重新登记，同样返回 403。
4. **`agent_product != "aiprobe"` 返回 400**：参考实现返回 403；任务说明要求「体不合法 → 400」，按任务说明执行。
5. **result 非 JSON 或非对象也按「结果不合格」处理**：任务记为 `FAILED(invalid_result)` 并返回 409。原因是返回 400 会让采集器退避约 10 小时不领新任务（§5.5）。超过 2 MiB 仍然返回 413，任务状态不变。
6. **场景有非 completed 时**：任务记为 FAILED，`errorCode=scenario_failed`，结果照常存库。
7. **`cleanup_error`、`output_excerpt` 的长度按 UTF-8 字节计**，与 AgentShield Go 的 `len(string)` 一致；参考实现按字符计。
8. **probe-reports 的 `accepted` 恒为 `true`**（重复上报时也是 `true`、`duplicate:true`）：规格只要求两者至少一个为 true。
9. **字符串含 NUL 一律拒绝**（heartbeat、register 返回 400，report 返回 422，result 返回 409）：PostgreSQL JSONB 不接受 `\u0000`，不拦的话会变成 500。
10. **环境变量没有放进 `src/config.ts`**：`src/config.ts` 在导入时用 zod 解析一次，开关无法在测试里按请求切换；而且本车道约定只改 `app.ts` 一处，所以沿用 `endpoint-evals` 的做法，放在模块内的 `config.ts`。
11. **限流是单进程内存令牌桶**：项目里原本没有限流实现。多副本部署时，各副本分别计数。

## 5. 安全要点

- 接入码和终端令牌只存 `sha256`，只在签发时返回一次明文。查找走哈希唯一索引，请求体里的 `endpoint_id` 用常量时间比较。
- 本插件的错误处理器和 404 处理器不记录请求头和请求体。Fastify 默认的请求日志只包含 method、url、IP。register 的响应体不进日志。测试会捕获 logger 输出，断言其中不含令牌、接入码和 `authorization`。
- 所有终端级数据都从「令牌 → 终端」解析。访问其他终端的任务返回 404。
- 服务端不访问请求里的任何 URL 或路径：`sink_base_url` 和报告里的地址只存不用。
- 所有响应都带 `Cache-Control: no-store`。
