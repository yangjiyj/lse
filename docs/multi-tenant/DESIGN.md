# 多租户设计（2026-11-06）

## 目标

不同租户（客户、部门）在同一套鉴盾里各自管理自己的评估资产（评估对象、终端与智能体、自建题集与样本、知识库），
各自做日常评估（评估任务、批量评估、评估计划、门禁、报告、风险处置），互相看不到、改不到。

## 模型

- `tenants` 表；固定 ID `00000000-0000-4000-8000-000000000001` 是**平台租户（默认租户）**：
  升级前的全部数据、平台管理员都在这里。
- **一个用户属于一个租户**（`users.tenantId`，必填）。用户名全平台唯一，登录不用选租户。
- **平台管理员** = 平台租户里有 `tenant:manage` 权限的用户（内置角色 `admin`）。可以新建/停用租户，
  在顶栏切换进入任何租户代管（请求头 `x-lse-tenant: <租户ID>`）。其他用户带这个头会被忽略。
- **租户管理员** = 内置角色 `tenant_admin`：本租户的用户管理 + 全部评估业务。建租户时同时建它的第一个管理员
  （记为内置账号，不能删除、停用、改角色）。
- **平台级权限**（`PLATFORM_ONLY_PERMISSIONS`：租户管理、授权许可、平台设置写、角色定义、标准题库发布）只对平台租户的用户生效，
  其他租户的用户登录态里一律剔除。「平台管理员」角色只能分配给平台租户的用户。
  平台管理员代管其他租户时代管期间同样剔除这些权限（保留 `tenant:manage` 以便切回），回到平台租户即恢复。
- 停用租户：该租户的账号不能登录，已登录的会话下一次请求即失效，API 令牌失效；平台管理员仍可进入处理。平台租户不能停用。

## 隔离怎么做

1. **请求上下文**（`apps/api/src/lib/tenant-context.ts`）：`app.ts` 的根 preHandler 为每个请求建立 AsyncLocalStorage 上下文，
   `authenticate`（以及 API 令牌鉴权）解析出本次操作的租户后写进去。
2. **数据访问层**（`apps/api/src/db.ts`）：全平台共用的 `prisma` 是带查询扩展的客户端，
   对 `lib/tenant-models.ts` 里列出的模型自动改写参数：
   - owned 模型：读、改、删都加 `tenantId = 当前租户`，新建自动打上当前租户；
   - shared 模型（评估对象、题集、题目、智能体样本、测试领域）：`tenantId` 为空表示**平台共享**（内置题集、内置样本、平台裁判模型、内置攻击领域），
     各租户可读不可改；只有平台管理员在平台租户里可以改；
   - 更新时不允许改归属租户。
   - 没有租户上下文时（后台 worker、终端接入协议 `/agent/v1`、种子数据、直接调用模块函数的测试）不过滤。
   - `prismaUnscoped` 是不带隔离的原始客户端，只给租户管理、登录这类本来就跨租户的地方用；
     `asSystem(async () => …)` 用于请求里少数要读平台级配置引用对象的地方。
   - `withTenant(tenantId, async () => …)`：后台任务（执行器、计划调度、技能/工具基线合并）没有请求上下文，
     按任务自己的 `tenantId` 临时进入租户范围，才能读到「本租户 + 平台共享」的裁判模型、门禁、题集。
3. **数据库兜底**（迁移 `20261106120000_multi_tenant` + `20261106130000_multi_tenant_isolation`）：
   - `lse_tenant_fill`：新行没带租户时，按参数顺序从父对象继承（如评估结果←任务←计划/评估对象←创建人），
     推不出来时归平台租户（共享模型按规则保持为空）。后台 worker 写入的数据因此自动落在正确的租户。
     其中 `@shared_platform_judge` 是给 `model_targets` 的专用规则：平台管理员在平台租户里建的判官模型
     显式写 `tenantId = NULL` 表示平台共享，不能被兜底填成平台租户（否则租户侧看不到它，llm-judge 会静默关掉）。
   - `lse_tenant_guard` / `lse_tenant_link_guard`：本行与父对象（或关联表两端）租户都不为空且不同 → 直接拒绝
     （错误码 42501，消息 `LSE_CROSS_TENANT_REFERENCE`）。即使某个接口漏了校验，也建不出跨租户的任务、计划、作业、
     门禁判定（`gate_evaluations` 两端 = 门禁 × 任务）。
   - 后加隔离的表：`ai_component_tool_baselines`（跟随首次扫描）、`test_domains`（跟随创建人）、
     `standard_bank_releases`（自动样本集记所属租户，平台发布的为空）。
4. **原始 SQL**（`$queryRaw`）不经过扩展，按任务 ID 查的不受影响；跨任务统计的（态势概览趋势、待复核工单时长）
   显式带上了 `"tenantId" = 当前租户`（`posture.ts` 的 `tenantSql()`）。
5. **唯一键必须带租户**：`ai_component_tool_baselines(tenantId, assetKey, toolName)`、`test_domains(tenantId, name)`、
   `external_asset_assessments(tenantId, sourceRequestId)`、`policy_suggestions(tenantId, scopeKey, groupKey)`。
   否则两个租户用同一个名字/请求号会互相撞键——轻则报 409，重则把别家的行当成自己的。

## 哪些表按租户隔离

见 `apps/api/src/lib/tenant-models.ts`（owned / shared 两张清单）和迁移里的触发器参数。
纯子表（任务日志、批量评估明细、标准专项样本与报告、RAG 文档/切片、服务核验组件、题集导入记录、门禁判定等）不加列：
它们只通过已按租户校验过的父对象访问，接口里先查父对象归属再动子表。
`StandardBankRelease` 故意不在清单里：它既可能是平台发布的标准题集，也可能是租户自动生成的样本集，
两处读取都显式按 `tenantId`（为空或等于当前租户）过滤。

**平台共享、不分租户**：角色与权限定义、平台设置、授权许可、标准题库（GB/T 45654 题目版本与发布）、攻击记忆、攻击包。
授权许可的用户数上限按全平台启用用户计。

## 只有平台租户能用的能力

网关集成是**全平台共用的一份**（地址、内部令牌、反代租户），落到同一个网关租户，所以这些接口对租户一律关闭：

- 网关日志分析与演练（`/api/gateway-logs/analyze`、`/drill/prepare`）→ 403 `PLATFORM_TENANT_ONLY`
- 策略下发（`/api/policy-suggestions/dispatch`、`/:id/refresh` 的网关分支）→ 403 `PLATFORM_TENANT_ONLY`
- AgentShield 终端清单（`/api/endpoint-evals/endpoints`）与船队控制台的 AgentShield 合并视图 → 租户拿到空列表
- 平台设置写、角色定义、标准题库发布、授权许可：靠权限剔除，租户侧看不见也调不通

评估对象里 `GATEWAY_LOG` / `ENDPOINT_AGENT` 两类连接是上述共用集成的入口，租户不允许新建。
平台共享对象（`tenantId` 为空）对租户只读：改名、删除、测试写回一律 403 `PLATFORM_TARGET_READONLY`。

## 存量数据迁移

全部归入平台租户，除了：内置题集（`isBuiltin`）及其题目、内置智能体样本、裁判模型（`targetType = JUDGE`）→ 平台共享。
平台管理员在平台租户里新建的裁判模型也是平台共享的；租户自己建的裁判模型只属于该租户，优先级按更新时间。

## 新增业务表时

需要按租户隔离：schema 加 `tenantId String?` + `@@index([tenantId])`，唯一键带上 `tenantId`，迁移里加列、回填、
`lse_tenant_10_fill` 触发器（必要时加 `lse_tenant_20_guard`），并把模型名加进 `tenant-models.ts`。
漏加的表不会被隔离。纯子表不需要加列，但每个读写路径都要先校验父对象归属（`prisma.<父>.findUnique` 查不到就 404），
否则就是这里审计出来的那批缺口。

## 测试注意

`prisma` 是扩展客户端，真正的查询最终落到 `prismaUnscoped`。要在测试里观测「某段逻辑读了哪些表」，
观测点必须同时挂在 `prisma._request` 和 `prismaUnscoped._request` 上（见 `test/eval-task-verdict.test.ts`）：
只挂扩展客户端会漏掉认证、事务这类走底层客户端的查询，断言会空跑通过。

## 资产归属转移（2026-11-07）

隔离解决「互不可见」，转移解决「归属划错了怎么改」。系统里没有、也不该有「随手改 tenantId」的接口：
`db.ts` 的 `stripTenant` 会把 update 里的 `tenantId` 剥掉，这是有意为之。转移是唯一例外，收在
`apps/api/src/lib/tenant-transfer.ts`，只允许 `modules/tenants` 的转移路由调用（`requirePlatformAdmin`），
用 `prismaUnscoped` 在一个事务里按依赖序搬。

- **接口**：`POST /api/tenants/transfer/preflight`（只读预演，返回条数/冲突/提醒）、`POST /api/tenants/transfer`
  （执行；内部重跑一次预检，有阻塞项直接 409，不信任前端结果）。
- **四类根对象**：评估对象（带计划、任务、结果、发现、错题、报告、策略建议、国标、RAG、组件扫描、门禁、模型文件、指纹）、
  终端（带探针报告与下发作业）、题集（带题目）、自建样本（带试验记录）。
- **顺序必须父先子后**：`lse_tenant_20_guard` 是 `BEFORE INSERT OR UPDATE OF "tenantId"`，改子对象时校验父对象同租户，
  顺序错了直接 42501、整个事务回滚。所以这个功能写错也造不出半搬状态——这是设计里唯一的兜底，不靠代码自觉。
- **六条语义**：① 以根对象为单位整棵子树一起走；② 全有或全无，不做部分成功；
  ③ `tenantId` 为空的平台共享对象（内置题集、内置题、平台裁判模型、内置样本）不可转移；
  ④ 任务引用了原租户自建题集时阻塞，必须先转移题集或单独处理任务，不自动改绑；
  ⑤ 终端的跨租户责任人（`ownerUserId`）转移时清空，`createdById` 等保留作历史事实；
  ⑥ 历史审计不搬，转移动作在源/目标租户各写一条 `tenant.asset.transfer-out` / `transfer-in`。
- **界面**：全部租户视角下，评估对象列表是勾选后「移到租户」，终端/题集/自建样本是行内「变更归属」。
  弹窗先选目标租户 → 服务端预检 → 列出将转移条数与冲突 → 确认。
